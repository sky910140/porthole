"""Policy-aware change proposal service shared by MCP and loopback APIs."""

from __future__ import annotations

import difflib
import hashlib
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from project_mcp.editor_readiness import EditorReadiness, ReadinessBlocked

from .content import StorageUnavailable
from .executor import ChangeExecutor, FileChanged, RecoveryRequired
from .models import ChangeRequest
from .recovery import recover_transaction
from .store import ChangeStore, RecordUnavailable


class ChangeService:
    def __init__(
        self,
        workspace: Callable[[str], object],
        store: ChangeStore,
        *,
        max_diff_bytes: int = 256 * 1024,
        readiness: EditorReadiness | None = None,
        diagnostics=None,
    ) -> None:
        self.workspace = workspace
        self.store = store
        self.max_diff_bytes = max_diff_bytes
        self.readiness = readiness
        self.diagnostics = diagnostics

    def _record(
        self,
        event_type: str,
        started: float,
        *,
        request_id: str | None = None,
        change_id: str | None = None,
        error_code: str | None = None,
    ) -> None:
        if self.diagnostics is None:
            return
        safe_request = None
        if request_id:
            safe_request = hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:16]
        health = {
            layer: check["state"] for layer, check in self.diagnostics.details_provider().get(
                "health", {},
            ).items()
        }
        try:
            self.diagnostics.record_event({
                "event_type": event_type,
                "request_id": safe_request,
                "change_id": change_id,
                "error_code": error_code,
                "duration_ms": max(0, int((time.perf_counter() - started) * 1000)),
                "health": health,
            })
        except (OSError, ValueError):
            pass

    @staticmethod
    def _allowed(workspace, path: str, capability: str) -> None:
        relative = workspace._validate_relative(path, allow_dot=False)
        if not workspace.policy.allows(relative, capability):
            raise PermissionError("PROJECT_FORBIDDEN: project policy does not allow proposals")
        # This also rejects linked or reparse-point traversal. The final file may
        # be absent for a create proposal, because no write happens here.
        workspace._resolve(path, allow_dot=False)

    def submit(self, actor_id: str, request: ChangeRequest | dict) -> dict:
        started = time.perf_counter()
        value = request if isinstance(request, ChangeRequest) else ChangeRequest.model_validate(request)
        workspace = self.workspace(value.project_id)
        for item in value.files:
            self._allowed(workspace, item.path, "propose")
        result = {**self.store.create(actor_id, value), "local_files_changed": False}
        self._record(
            "change_submit", started, request_id=value.request_id,
            change_id=result["change_id"],
        )
        return result

    def get(self, actor_id: str, project_id: str, change_id: str) -> dict:
        started = time.perf_counter()
        workspace = self.workspace(project_id)
        result = self.store.get(actor_id, project_id, change_id)
        files = self.store.files(actor_id, project_id, change_id)
        for item in files:
            self._allowed(workspace, item["path"], "read")
        result = {
            **result,
            "project_id": project_id,
            "files": [{
                key: item[key]
                for key in ("path", "operation", "base_sha256", "content_sha256")
            } for item in files],
        }
        self._record("change_query", started, change_id=change_id)
        return result

    def diff(self, actor_id: str, project_id: str, change_id: str) -> dict:
        workspace = self.workspace(project_id)
        result = self.store.get(actor_id, project_id, change_id)
        records = self.store.files(actor_id, project_id, change_id)
        chunks: list[str] = []
        for item in records:
            self._allowed(workspace, item["path"], "read")
            proposed = self.store.content.get_bytes(item["content_blob_id"]).decode("utf-8")
            if item["operation"] == "create":
                current = ""
            else:
                target = workspace.resolve_file(item["path"], "read")
                current = target.read_text(encoding="utf-8")
            chunks.extend(difflib.unified_diff(
                current.splitlines(keepends=True),
                proposed.splitlines(keepends=True),
                fromfile=f"a/{item['path']}",
                tofile=f"b/{item['path']}",
                lineterm="\n",
            ))
        rendered = "".join(chunks)
        encoded = rendered.encode("utf-8")
        truncated = len(encoded) > self.max_diff_bytes
        if truncated:
            encoded = encoded[: self.max_diff_bytes]
            while True:
                try:
                    rendered = encoded.decode("utf-8")
                    break
                except UnicodeDecodeError:
                    encoded = encoded[:-1]
        return {
            "change_id": change_id,
            "project_id": project_id,
            "state": result["state"],
            "revision": result["revision"],
            "manifest_sha256": result["manifest_sha256"],
            "diff": rendered,
            "source": "change_proposal",
            "truncated": truncated,
            "truncation_reason": "output_limit" if truncated else None,
        }

    def apply_without_readiness(self, change_id: str, data: dict) -> dict:
        operation_id = data.get("operation_id")
        expected_revision = data.get("expected_revision")
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 128:
            raise ValueError("operation_id is required")
        if not isinstance(expected_revision, int) or expected_revision < 1:
            raise ValueError("expected_revision is required")
        identity = self.store.local_identity(change_id)
        parameters = {"expected_revision": expected_revision, "kind": "apply"}
        existing = self.store.begin_operation(
            operation_id, change_id, identity["actor_id"], "apply", parameters,
        )
        if existing is not None:
            return existing
        current = self.store.get(identity["actor_id"], identity["project_id"], change_id)
        if current["revision"] != expected_revision:
            result = {
                "change_id": change_id,
                "state": current["state"],
                "revision": current["revision"],
                "error_code": "IDEMPOTENCY_CONFLICT",
                "blocked_reason": "expected revision no longer matches",
            }
            self.store.finish_operation(operation_id, result)
            return result
        result = {
            "change_id": change_id,
            "state": current["state"],
            "revision": current["revision"],
            "error_code": "EDITOR_UNAVAILABLE",
            "blocked_reason": "VS Code review readiness is not enabled",
        }
        self.store.finish_operation(operation_id, result)
        return result

    def local_detail(self, change_id: str, *, include_content: bool = True) -> dict:
        record = self.store.local_record(change_id)
        files = self.store.files(record["actor_id"], record["project_id"], change_id)
        rendered_files = []
        for item in files:
            value = {
                key: item[key]
                for key in ("path", "operation", "base_sha256", "content_sha256")
            }
            if include_content:
                value["content_utf8"] = self.store.content.get_bytes(
                    item["content_blob_id"],
                ).decode("utf-8")
            rendered_files.append(value)
        undo_expires_at = None
        undo_available = False
        if record["state"] == "applied":
            undo_expires_at = (
                datetime.fromisoformat(record["updated_at"]) + timedelta(days=7)
            ).astimezone(UTC).isoformat()
            try:
                transaction = self.store.transaction(change_id, "apply")
                undo_available = all(
                    item["content_blob_id"] is not None
                    and (item["operation"] == "create" or item["backup_blob_id"] is not None)
                    for item in transaction["files"]
                )
            except (RecordUnavailable, StorageUnavailable):
                undo_available = False
        return {
            key: value for key, value in record.items() if key != "actor_id"
        } | {
            "files": rendered_files,
            "undo_available": undo_available,
            "undo_expires_at": undo_expires_at,
        }

    def _identity_and_paths(self, change_id: str) -> tuple[dict, list[dict]]:
        record = self.store.local_record(change_id)
        files = self.store.files(record["actor_id"], record["project_id"], change_id)
        return record, files

    def _mark_disk_conflict(self, record: dict, files: list[dict]) -> None:
        workspace = self.workspace(record["project_id"])
        changed = False
        for item in files:
            target = workspace._resolve(item["path"], allow_dot=False)
            if item["operation"] == "create":
                changed = target.exists() or target.is_symlink()
            else:
                try:
                    current = target.read_bytes() if target.is_file() and not target.is_symlink() else None
                except OSError:
                    current = None
                changed = current is None or hashlib.sha256(current).hexdigest() != item["base_sha256"]
            if changed:
                break
        if changed:
            if record["state"] == "pending_review":
                self.store.transition(
                    record["actor_id"], record["project_id"], record["change_id"],
                    expected_revision=record["revision"], expected_states={"pending_review"},
                    new_state="conflict", error_code="FILE_CHANGED",
                )
            raise ReadinessBlocked("FILE_CHANGED", "project files changed after proposal")

    def issue_readiness(self, change_id: str, data: dict) -> dict:
        if self.readiness is None:
            raise ReadinessBlocked("EDITOR_UNAVAILABLE", "editor readiness is not configured")
        session_id = data.get("review_session_id")
        manifest = data.get("manifest_sha256")
        record, files = self._identity_and_paths(change_id)
        if record["state"] not in {"pending_review", "applied", "recovery_required"}:
            raise ReadinessBlocked("EDITOR_UNAVAILABLE", "change is not reviewable")
        if manifest != record["manifest_sha256"]:
            raise ReadinessBlocked("LEASE_EXPIRED", "reviewed manifest does not match")
        workspace = self.workspace(record["project_id"])
        for item in files:
            self._allowed(workspace, item["path"], "apply_local")
        if record["state"] == "pending_review":
            self._mark_disk_conflict(record, files)
        return self.readiness.issue(
            record["project_id"], change_id, session_id, manifest,
            [item["path"] for item in files],
        )

    def apply_reviewed(self, change_id: str, data: dict) -> dict:
        started = time.perf_counter()
        if self.readiness is None:
            raise ReadinessBlocked("EDITOR_UNAVAILABLE", "editor readiness is not configured")
        operation_id = data.get("operation_id")
        expected_revision = data.get("expected_revision")
        session_id = data.get("review_session_id")
        manifest = data.get("manifest_sha256")
        lease_id = data.get("lease_id")
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 128:
            raise ValueError("operation_id is required")
        if not isinstance(expected_revision, int) or expected_revision < 1:
            raise ValueError("expected_revision is required")
        if not all(isinstance(value, str) and value for value in (session_id, manifest, lease_id)):
            raise ReadinessBlocked(
                "EDITOR_UNAVAILABLE", "an active VS Code review and readiness lease are required",
            )
        record, files = self._identity_and_paths(change_id)
        parameters = {
            "expected_revision": expected_revision,
            "review_session_id": session_id,
            "manifest_sha256": manifest,
            "lease_id": lease_id,
            "kind": "apply",
        }
        existing = self.store.begin_operation(
            operation_id, change_id, record["actor_id"], "apply", parameters,
        )
        if existing is not None:
            return existing

        def finish(result: dict) -> dict:
            self.store.finish_operation(operation_id, result)
            self._record(
                "change_apply", started, change_id=change_id,
                error_code=result.get("error_code"),
            )
            return result

        if record["revision"] != expected_revision or record["state"] != "pending_review":
            return finish({
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": "IDEMPOTENCY_CONFLICT",
                "blocked_reason": "expected revision or state no longer matches",
            })
        if manifest != record["manifest_sha256"]:
            return finish({
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": "LEASE_EXPIRED",
                "blocked_reason": "reviewed manifest does not match",
            })
        paths = [item["path"] for item in files]
        try:
            self.readiness.consume(
                lease_id, record["project_id"], change_id, session_id, manifest, paths=paths,
            )
            self._mark_disk_conflict(record, files)
            workspace = self.workspace(record["project_id"])
            result = ChangeExecutor(
                workspace.root, record["project_id"], record["actor_id"],
                self.store, workspace.policy,
            ).apply(change_id)
        except ReadinessBlocked as exc:
            current = self.store.local_record(change_id)
            return finish({
                "change_id": change_id, "state": current["state"],
                "revision": current["revision"], "error_code": exc.error_code,
                "blocked_reason": exc.message,
            })
        except FileChanged as exc:
            current = self.store.local_record(change_id)
            return finish({
                "change_id": change_id, "state": current["state"],
                "revision": current["revision"], "error_code": "FILE_CHANGED",
                "blocked_reason": str(exc),
            })
        except PermissionError as exc:
            current = self.store.local_record(change_id)
            return finish({
                "change_id": change_id, "state": current["state"],
                "revision": current["revision"], "error_code": "PROJECT_FORBIDDEN",
                "blocked_reason": str(exc),
            })
        return finish(result)

    def reject(self, change_id: str, data: dict) -> dict:
        started = time.perf_counter()
        operation_id = data.get("operation_id")
        expected_revision = data.get("expected_revision")
        if not isinstance(operation_id, str) or not operation_id:
            raise ValueError("operation_id is required")
        record = self.store.local_record(change_id)
        parameters = {"expected_revision": expected_revision, "kind": "reject"}
        existing = self.store.begin_operation(
            operation_id, change_id, record["actor_id"], "reject", parameters,
        )
        if existing is not None:
            return existing
        if record["revision"] != expected_revision or record["state"] != "pending_review":
            result = {
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": "IDEMPOTENCY_CONFLICT",
                "blocked_reason": "expected revision or state no longer matches",
            }
            self.store.finish_operation(operation_id, result)
            return result
        result = self.store.transition(
            record["actor_id"], record["project_id"], change_id,
            expected_revision=expected_revision, expected_states={"pending_review"},
            new_state="rejected", transaction_kind="reject",
        )
        self.store.finish_operation(operation_id, result)
        self._record("change_reject", started, change_id=change_id)
        return result

    def revert(self, change_id: str, data: dict) -> dict:
        started = time.perf_counter()
        operation_id = data.get("operation_id")
        expected_revision = data.get("expected_revision")
        session_id = data.get("review_session_id")
        manifest = data.get("manifest_sha256")
        lease_id = data.get("lease_id")
        if not isinstance(operation_id, str) or not operation_id:
            raise ValueError("operation_id is required")
        if not all(isinstance(value, str) and value for value in (session_id, manifest, lease_id)):
            raise ReadinessBlocked(
                "EDITOR_UNAVAILABLE", "an active VS Code review and readiness lease are required",
            )
        record = self.store.local_record(change_id)
        parameters = {
            "expected_revision": expected_revision, "review_session_id": session_id,
            "manifest_sha256": manifest, "lease_id": lease_id, "kind": "revert",
        }
        existing = self.store.begin_operation(
            operation_id, change_id, record["actor_id"], "revert", parameters,
        )
        if existing is not None:
            return existing
        files = self.store.files(record["actor_id"], record["project_id"], change_id)
        if record["revision"] != expected_revision or record["state"] != "applied":
            result = {
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": "IDEMPOTENCY_CONFLICT",
                "blocked_reason": "expected revision or state no longer matches",
            }
            self.store.finish_operation(operation_id, result)
            return result
        try:
            self.readiness.consume(
                lease_id, record["project_id"], change_id, session_id, manifest,
                paths=[item["path"] for item in files],
            )
            workspace = self.workspace(record["project_id"])
            result = ChangeExecutor(
                workspace.root, record["project_id"], record["actor_id"],
                self.store, workspace.policy,
            ).revert(change_id)
        except ReadinessBlocked as exc:
            result = {
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": exc.error_code,
                "blocked_reason": exc.message,
            }
        except FileChanged as exc:
            current = self.store.local_record(change_id)
            result = {
                "change_id": change_id, "state": current["state"],
                "revision": current["revision"], "error_code": "FILE_CHANGED",
                "blocked_reason": str(exc),
            }
        self.store.finish_operation(operation_id, result)
        self._record(
            "change_revert", started, change_id=change_id,
            error_code=result.get("error_code"),
        )
        return result

    def recover(self, change_id: str, data: dict) -> dict:
        started = time.perf_counter()
        action = data.get("action")
        operation_id = data.get("operation_id")
        expected_revision = data.get("expected_revision")
        session_id = data.get("review_session_id")
        manifest = data.get("manifest_sha256")
        lease_id = data.get("lease_id")
        if not isinstance(operation_id, str) or not operation_id:
            raise ValueError("operation_id is required")
        if action not in {"verify", "rollback"}:
            raise ValueError("recovery action must be verify or rollback")
        if action == "rollback" and not all(
            isinstance(value, str) and value for value in (session_id, manifest, lease_id)
        ):
            raise ReadinessBlocked(
                "EDITOR_UNAVAILABLE", "recovery rollback requires a fresh VS Code review lease",
            )
        record = self.store.local_record(change_id)
        parameters = {
            "expected_revision": expected_revision, "action": action,
            "review_session_id": session_id, "manifest_sha256": manifest,
            "lease_id": lease_id, "kind": "recover",
        }
        existing = self.store.begin_operation(
            operation_id, change_id, record["actor_id"], "recover", parameters,
        )
        if existing is not None:
            return existing
        if record["revision"] != expected_revision:
            result = {
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": "IDEMPOTENCY_CONFLICT",
                "blocked_reason": "expected revision no longer matches",
            }
            self.store.finish_operation(operation_id, result)
            return result
        workspace = self.workspace(record["project_id"])
        executor = ChangeExecutor(
            workspace.root, record["project_id"], record["actor_id"],
            self.store, workspace.policy,
        )
        try:
            if action == "rollback":
                files = self.store.files(
                    record["actor_id"], record["project_id"], change_id,
                )
                self.readiness.consume(
                    lease_id, record["project_id"], change_id, session_id, manifest,
                    paths=[item["path"] for item in files],
                )
            result = recover_transaction(executor, change_id, action)
        except ReadinessBlocked as exc:
            result = {
                "change_id": change_id, "state": record["state"],
                "revision": record["revision"], "error_code": exc.error_code,
                "blocked_reason": exc.message,
            }
        except RecoveryRequired as exc:
            current = self.store.local_record(change_id)
            result = {
                "change_id": change_id, "state": current["state"],
                "revision": current["revision"], "error_code": "RECOVERY_REQUIRED",
                "blocked_reason": str(exc),
            }
        self.store.finish_operation(operation_id, result)
        self._record(
            "change_recovery", started, change_id=change_id,
            error_code=result.get("error_code"),
        )
        return result
