"""Single production write path for reviewed local change proposals."""

from __future__ import annotations

import hashlib
import os
import stat
import threading
import uuid
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from .content import StorageUnavailable

if TYPE_CHECKING:
    from project_mcp.policy import ProjectPolicy

    from .store import ChangeStore


class FileChanged(RuntimeError):
    pass


class RecoveryRequired(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class LocalFileOperations:
    """Small injectable adapter around the non-atomic multi-file boundary."""

    @staticmethod
    def _write_temp(target: Path, data: bytes, mode: int) -> Path:
        temp = target.with_name(f".{target.name}.porthole-{uuid.uuid4().hex}.tmp")
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode or 0o600)
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.close(descriptor)
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temp.unlink(missing_ok=True)
            raise
        os.chmod(temp, mode or 0o600)
        return temp

    @staticmethod
    def _copy_windows_security(source: Path, target: Path) -> None:
        if os.name != "nt":
            return
        try:
            import pywintypes
            import win32security
        except ImportError as exc:
            raise PermissionError("Windows security support is unavailable") from exc
        try:
            flags = (
                win32security.OWNER_SECURITY_INFORMATION
                | win32security.GROUP_SECURITY_INFORMATION
                | win32security.DACL_SECURITY_INFORMATION
            )
            descriptor = win32security.GetFileSecurity(str(source), flags)
            win32security.SetFileSecurity(str(target), flags, descriptor)
        except pywintypes.error as exc:
            raise PermissionError("cannot preserve the original Windows security descriptor") from exc

    def replace(self, target: Path, data: bytes, mode: int | None) -> None:
        temp = self._write_temp(target, data, mode or 0o600)
        try:
            self._copy_windows_security(target, temp)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)

    def create(self, target: Path, data: bytes, mode: int = 0o600) -> None:
        temp = self._write_temp(target, data, mode)
        try:
            os.link(temp, target)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def remove(target: Path) -> None:
        target.unlink()


class ChangeExecutor:
    _global_write_lock = threading.Lock()

    def __init__(
        self,
        root: Path,
        project_id: str,
        actor_id: str,
        store: ChangeStore,
        policy: ProjectPolicy,
        *,
        file_ops: LocalFileOperations | None = None,
        fault_injector=None,
        cancel_requested=None,
    ) -> None:
        self.root = Path(root).resolve(strict=True)
        self.project_id = project_id
        self.actor_id = actor_id
        self.store = store
        self.policy = policy
        self.filesystem = file_ops or LocalFileOperations()
        self.fault = fault_injector or (lambda _point, _path=None: None)
        self.cancel_requested = cancel_requested or (lambda: False)

    def _target(self, relative: str) -> Path:
        posix = PurePosixPath(relative.replace("\\", "/"))
        if not self.policy.allows(posix, "apply_local"):
            raise PermissionError("project policy does not allow local apply")
        candidate = self.root.joinpath(*posix.parts)
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise PermissionError("path escapes project") from exc
        current = self.root
        for part in posix.parts[:-1]:
            current /= part
            if not current.is_dir() or current.is_symlink():
                raise PermissionError("parent path is unavailable or linked")
            info = current.stat(follow_symlinks=False)
            if getattr(info, "st_file_attributes", 0) & getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
            ):
                raise PermissionError("parent path uses a reparse point")
        if candidate.is_symlink():
            raise PermissionError("linked targets are not writable")
        try:
            resolved_parent = candidate.parent.resolve(strict=True)
            resolved_parent.relative_to(self.root)
        except (OSError, ValueError) as exc:
            raise PermissionError("target parent escapes project") from exc
        return candidate

    @staticmethod
    def _current_hash(target: Path) -> str | None:
        try:
            if not target.is_file() or target.is_symlink():
                return None
            return digest(target.read_bytes())
        except OSError:
            return None

    def _prepare_apply(self, change_id: str) -> tuple[dict, list[dict]]:
        result = self.store.get(self.actor_id, self.project_id, change_id)
        if result["state"] != "pending_review":
            raise FileChanged(f"change is not pending review: {result['state']}")
        records = self.store.files(self.actor_id, self.project_id, change_id)
        prepared = []
        physical: set[tuple[int, int]] = set()
        for record in records:
            target = self._target(record["path"])
            after = self.store.content.get_bytes(record["content_blob_id"])
            if digest(after) != record["content_sha256"]:
                raise StorageUnavailable("proposed content hash mismatch")
            before = None
            mode = None
            if record["operation"] == "create":
                if target.exists() or target.is_symlink():
                    self._mark_conflict(result)
                    raise FileChanged("FILE_CHANGED: create target already exists")
            else:
                if not target.is_file() or target.is_symlink():
                    self._mark_conflict(result)
                    raise FileChanged("FILE_CHANGED: modify target is unavailable")
                info = target.stat(follow_symlinks=False)
                if info.st_nlink > 1:
                    raise PermissionError("hard link targets are not writable")
                identity = (info.st_dev, info.st_ino)
                if identity in physical:
                    raise PermissionError("multiple paths resolve to one file")
                physical.add(identity)
                before = target.read_bytes()
                if digest(before) != record["base_sha256"]:
                    self._mark_conflict(result)
                    raise FileChanged("FILE_CHANGED: base hash does not match")
                mode = stat.S_IMODE(info.st_mode)
            backup = self.store.content.put_bytes(before) if before is not None else None
            prepared.append({
                **record,
                "target": target,
                "before_sha256": digest(before) if before is not None else None,
                "after_sha256": digest(after),
                "backup_blob_id": backup,
                "original_mode": mode,
                "after_bytes": after,
            })
        return result, prepared

    def _mark_conflict(self, result: dict) -> None:
        self.store.transition(
            self.actor_id, self.project_id, result["change_id"],
            expected_revision=result["revision"], expected_states={"pending_review"},
            new_state="conflict", error_code="FILE_CHANGED",
        )

    @staticmethod
    def _journal_files(prepared: list[dict]) -> list[dict]:
        keys = {
            "path", "operation", "before_sha256", "after_sha256", "backup_blob_id",
            "content_blob_id", "original_mode",
        }
        return [{key: item.get(key) for key in keys} for item in prepared]

    def apply(self, change_id: str) -> dict:
        with self._global_write_lock:
            result, prepared = self._prepare_apply(change_id)
            started = self.store.start_transaction(
                self.actor_id, self.project_id, change_id,
                expected_revision=result["revision"], expected_state="pending_review",
                kind="apply", files=self._journal_files(prepared),
            )
            self.fault("after_backups", None)
            try:
                for ordinal, item in enumerate(prepared):
                    if self.cancel_requested():
                        return self._require_recovery(started, "operation cancelled")
                    self._assert_before(item)
                    self.fault("before_file", item["path"])
                    if item["operation"] == "create":
                        self.filesystem.create(item["target"], item["after_bytes"])
                    else:
                        self.filesystem.replace(
                            item["target"], item["after_bytes"], item["original_mode"],
                        )
                    self._assert_after(item)
                    self.store.set_transaction_file_phase(change_id, "apply", ordinal, "applied")
                    self.fault("after_file", item["path"])
                self.fault("before_terminal", None)
            except (OSError, RuntimeError) as exc:
                if self._try_rollback(
                    self.store.transaction(change_id, "apply"), "apply"
                ):
                    self.store.set_transaction_phase(change_id, "apply", "rolled_back")
                    return self.store.transition(
                        self.actor_id, self.project_id, change_id,
                        expected_revision=started["revision"], expected_states={"applying"},
                        new_state="rolled_back", transaction_kind="apply",
                        blocked_reason=str(exc),
                    )
                return self._require_recovery(started, str(exc))
            self.store.set_transaction_phase(change_id, "apply", "complete")
            return self.store.transition(
                self.actor_id, self.project_id, change_id,
                expected_revision=started["revision"], expected_states={"applying"},
                new_state="applied", transaction_kind="apply",
            )

    def _assert_before(self, item: dict) -> None:
        current = self._current_hash(item["target"])
        expected = item["before_sha256"]
        if current != expected:
            raise FileChanged("FILE_CHANGED: target changed after preflight")

    def _assert_after(self, item: dict) -> None:
        if self._current_hash(item["target"]) != item["after_sha256"]:
            raise RecoveryRequired("RECOVERY_REQUIRED: target hash after write is unexpected")
        if item["operation"] == "modify":
            mode = stat.S_IMODE(item["target"].stat(follow_symlinks=False).st_mode)
            if mode != item["original_mode"]:
                raise RecoveryRequired("RECOVERY_REQUIRED: file permissions changed")

    def _require_recovery(self, started: dict, reason: str) -> dict:
        change_id = started["change_id"]
        kind = self.store.transaction_kind(self.actor_id, self.project_id, change_id)
        self.store.set_transaction_phase(change_id, kind, "recovery_required")
        return self.store.transition(
            self.actor_id, self.project_id, change_id,
            expected_revision=started["revision"], expected_states={"applying", "reverting"},
            new_state="recovery_required", transaction_kind=kind,
            blocked_reason=reason, error_code="RECOVERY_REQUIRED",
        )

    def _restore_before(self, item: dict) -> None:
        target = self._target(item["path"])
        if item["operation"] == "create":
            self.filesystem.remove(target)
            return
        before = self.store.content.get_bytes(item["backup_blob_id"])
        self.filesystem.replace(target, before, item["original_mode"])

    def _restore_after(self, item: dict) -> None:
        target = self._target(item["path"])
        after = self.store.content.get_bytes(item["content_blob_id"])
        if item["operation"] == "create" and not target.exists():
            self.filesystem.create(target, after)
        else:
            self.filesystem.replace(target, after, item["original_mode"])

    def _rollback_transaction(self, transaction: dict, kind: str) -> bool:
        for item in reversed(transaction["files"]):
            target = self._target(item["path"])
            current = self._current_hash(target)
            before = item["before_sha256"]
            after = item["after_sha256"]
            if kind == "apply":
                if current == after:
                    self._restore_before(item)
                elif current != before:
                    return False
            else:
                if current == before:
                    self._restore_after(item)
                elif current != after:
                    return False
        return True

    def _try_rollback(self, transaction: dict, kind: str) -> bool:
        try:
            return self._rollback_transaction(transaction, kind)
        except (OSError, RuntimeError):
            return False

    def revert(self, change_id: str) -> dict:
        with self._global_write_lock:
            result = self.store.get(self.actor_id, self.project_id, change_id)
            if result["state"] != "applied":
                raise FileChanged(f"change is not applied: {result['state']}")
            applied = self.store.transaction(change_id, "apply")
            for item in applied["files"]:
                if item["content_blob_id"] is None or (
                    item["operation"] == "modify" and item["backup_blob_id"] is None
                ):
                    raise StorageUnavailable("undo content is no longer retained")
                if self._current_hash(self._target(item["path"])) != item["after_sha256"]:
                    raise FileChanged("FILE_CHANGED: target changed after apply")
            started = self.store.start_transaction(
                self.actor_id, self.project_id, change_id,
                expected_revision=result["revision"], expected_state="applied", kind="revert",
                files=[{key: item.get(key) for key in (
                    "path", "operation", "before_sha256", "after_sha256", "backup_blob_id",
                    "content_blob_id", "original_mode",
                )} for item in applied["files"]],
            )
            try:
                for ordinal, item in enumerate(applied["files"]):
                    if self.cancel_requested():
                        return self._require_recovery(started, "operation cancelled")
                    if self._current_hash(self._target(item["path"])) != item["after_sha256"]:
                        raise FileChanged("FILE_CHANGED: target changed during revert")
                    self.fault("before_revert_file", item["path"])
                    self._restore_before(item)
                    self.store.set_transaction_file_phase(change_id, "revert", ordinal, "reverted")
                    self.fault("after_revert_file", item["path"])
                self.fault("before_revert_terminal", None)
            except (OSError, RuntimeError) as exc:
                if self._try_rollback(
                    self.store.transaction(change_id, "revert"), "revert"
                ):
                    self.store.set_transaction_phase(change_id, "revert", "rolled_back")
                    return self.store.transition(
                        self.actor_id, self.project_id, change_id,
                        expected_revision=started["revision"], expected_states={"reverting"},
                        new_state="applied", transaction_kind="revert", blocked_reason=str(exc),
                    )
                return self._require_recovery(started, str(exc))
            self.store.set_transaction_phase(change_id, "revert", "complete")
            return self.store.transition(
                self.actor_id, self.project_id, change_id,
                expected_revision=started["revision"], expected_states={"reverting"},
                new_state="reverted", transaction_kind="revert",
            )

    def recover(self, change_id: str, action: str) -> dict:
        from .recovery import recover_transaction

        with self._global_write_lock:
            return recover_transaction(self, change_id, action)
