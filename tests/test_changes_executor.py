from __future__ import annotations

import hashlib
import os
import sys

import pytest
from cryptography.fernet import Fernet


class MemoryKeyProvider:
    def __init__(self):
        self.key = Fernet.generate_key()

    def get_key(self):
        return self.key


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def setup_engine(tmp_path, files, *, fault=None, cancel=None, file_ops=None):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.executor import ChangeExecutor
    from project_mcp.changes.store import ChangeStore
    from project_mcp.policy import ProjectPolicy

    content = ProtectedContentStore(tmp_path / ".state" / "content", MemoryKeyProvider())
    store = ChangeStore(tmp_path / ".state" / "changes.db", content)
    request = {
        "project_id": "demo", "request_id": "request-1", "summary": "update files",
        "files": files,
    }
    change = store.create("owner", request)
    executor = ChangeExecutor(
        tmp_path, "demo", "owner", store,
        ProjectPolicy(mode="propose", apply_local_enabled=True),
        fault_injector=fault, cancel_requested=cancel, file_ops=file_ops,
    )
    return executor, store, change


def test_applies_utf8_create_and_modify_without_normalizing_bytes_or_permissions(tmp_path):
    original = b"before\r\n\xef\xbb\xbfkeep\n"
    target = b"after\r\n\xef\xbb\xbfkeep\n"
    (tmp_path / "src").mkdir()
    existing = tmp_path / "src" / "旧文件.txt"
    existing.write_bytes(original)
    os.chmod(existing, 0o600)
    original_mode = existing.stat().st_mode & 0o777
    executor, store, change = setup_engine(tmp_path, [
        {"path": "src/旧文件.txt", "operation": "modify", "base_sha256": sha(original),
         "content_utf8": target.decode("utf-8")},
        {"path": "src/new.txt", "operation": "create", "base_sha256": None,
         "content_utf8": "created\r\n"},
    ])
    result = executor.apply(change["change_id"])
    assert result["state"] == "applied"
    assert existing.read_bytes() == target
    assert (tmp_path / "src" / "new.txt").read_bytes() == b"created\r\n"
    assert existing.stat().st_mode & 0o777 == original_mode
    assert store.transaction(change["change_id"], "apply")["phase"] == "complete"


@pytest.mark.parametrize("kind", ["base_changed", "create_exists"])
def test_preflight_conflicts_do_not_partially_write(tmp_path, kind):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(b"changed" if kind == "base_changed" else before)
    operation = "modify" if kind == "base_changed" else "create"
    base = sha(before) if operation == "modify" else None
    executor, store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": operation, "base_sha256": base,
        "content_utf8": "after",
    }])
    with pytest.raises(Exception, match="FILE_CHANGED"):
        executor.apply(change["change_id"])
    assert path.read_bytes() == (b"changed" if kind == "base_changed" else before)
    assert store.get("owner", "demo", change["change_id"])["state"] == "conflict"


def test_rejects_hard_link_targets_and_policy_revocation(tmp_path):
    from project_mcp.changes.executor import ChangeExecutor
    from project_mcp.policy import ProjectPolicy

    original = b"before"
    target = tmp_path / "target.txt"
    target.write_bytes(original)
    alias = tmp_path / "alias.txt"
    try:
        os.link(target, alias)
    except OSError:
        pytest.skip("hard links unavailable")
    executor, store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(original),
        "content_utf8": "after",
    }])
    with pytest.raises(PermissionError, match="hard link"):
        executor.apply(change["change_id"])
    blocked = ChangeExecutor(
        tmp_path, "demo", "owner", store, ProjectPolicy(mode="read_only"),
    )
    with pytest.raises(PermissionError):
        blocked.apply(change["change_id"])


def test_write_failure_rolls_back_completed_files(tmp_path):
    from project_mcp.changes.executor import LocalFileOperations

    class FailSecond(LocalFileOperations):
        def replace(self, target, data, mode):
            if target.name == "b.txt":
                raise PermissionError("locked")
            return super().replace(target, data, mode)

    for name in ("a.txt", "b.txt"):
        (tmp_path / name).write_bytes(name.encode())
    executor, _store, change = setup_engine(tmp_path, [
        {"path": name, "operation": "modify", "base_sha256": sha(name.encode()),
         "content_utf8": f"new-{name}"} for name in ("a.txt", "b.txt")
    ], file_ops=FailSecond())
    result = executor.apply(change["change_id"])
    assert result["state"] == "rolled_back"
    assert (tmp_path / "a.txt").read_bytes() == b"a.txt"
    assert (tmp_path / "b.txt").read_bytes() == b"b.txt"


def test_cancel_after_one_file_stops_with_recovery_required(tmp_path):
    calls = 0

    def cancelled():
        nonlocal calls
        calls += 1
        return calls >= 2

    for name in ("a.txt", "b.txt"):
        (tmp_path / name).write_bytes(name.encode())
    executor, _store, change = setup_engine(tmp_path, [
        {"path": name, "operation": "modify", "base_sha256": sha(name.encode()),
         "content_utf8": f"new-{name}"} for name in ("a.txt", "b.txt")
    ], cancel=cancelled)
    result = executor.apply(change["change_id"])
    assert result["state"] == "recovery_required"
    assert (tmp_path / "a.txt").read_bytes() == b"new-a.txt"
    assert (tmp_path / "b.txt").read_bytes() == b"b.txt"


def test_path_escape_and_symlink_are_rejected_at_execution_time(tmp_path):
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = tmp_path / "link.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    executor, _store, change = setup_engine(tmp_path, [{
        "path": "link.txt", "operation": "modify", "base_sha256": sha(b"outside"),
        "content_utf8": "changed",
    }])
    with pytest.raises(PermissionError):
        executor.apply(change["change_id"])
    assert outside.read_text(encoding="utf-8") == "outside"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows sharing violation behavior")
def test_real_windows_file_lock_returns_a_safe_rolled_back_state(tmp_path):
    before = b"before"
    target = tmp_path / "locked.txt"
    target.write_bytes(before)
    executor, _store, change = setup_engine(tmp_path, [{
        "path": "locked.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }])
    with target.open("rb"):
        result = executor.apply(change["change_id"])
    assert result["state"] == "rolled_back"
    assert target.read_bytes() == before
