"""Policy-aware change proposal service shared by MCP and loopback APIs."""

from __future__ import annotations

import difflib
from collections.abc import Callable

from .models import ChangeRequest
from .store import ChangeStore


class ChangeService:
    def __init__(
        self,
        workspace: Callable[[str], object],
        store: ChangeStore,
        *,
        max_diff_bytes: int = 256 * 1024,
    ) -> None:
        self.workspace = workspace
        self.store = store
        self.max_diff_bytes = max_diff_bytes

    @staticmethod
    def _allowed(workspace, path: str, capability: str) -> None:
        relative = workspace._validate_relative(path, allow_dot=False)
        if not workspace.policy.allows(relative, capability):
            raise PermissionError("PROJECT_FORBIDDEN: project policy does not allow proposals")
        # This also rejects linked or reparse-point traversal. The final file may
        # be absent for a create proposal, because no write happens here.
        workspace._resolve(path, allow_dot=False)

    def submit(self, actor_id: str, request: ChangeRequest | dict) -> dict:
        value = request if isinstance(request, ChangeRequest) else ChangeRequest.model_validate(request)
        workspace = self.workspace(value.project_id)
        for item in value.files:
            self._allowed(workspace, item.path, "propose")
        return {**self.store.create(actor_id, value), "local_files_changed": False}

    def get(self, actor_id: str, project_id: str, change_id: str) -> dict:
        workspace = self.workspace(project_id)
        result = self.store.get(actor_id, project_id, change_id)
        files = self.store.files(actor_id, project_id, change_id)
        for item in files:
            self._allowed(workspace, item["path"], "read")
        return {
            **result,
            "project_id": project_id,
            "files": [{
                key: item[key]
                for key in ("path", "operation", "base_sha256", "content_sha256")
            } for item in files],
        }

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
