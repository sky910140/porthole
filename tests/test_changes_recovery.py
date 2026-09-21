from __future__ import annotations

import hashlib

import pytest
from test_changes_executor import setup_engine

from project_mcp.changes.executor import FileChanged, RecoveryRequired


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AbruptStop(BaseException):
    pass


@pytest.mark.parametrize("crash_point", ["after_backups", "before_file"])
def test_restart_before_first_replacement_verifies_rolled_back(tmp_path, crash_point):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(before)

    def crash(point, _path=None):
        if point == crash_point:
            raise AbruptStop()

    executor, _store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }], fault=crash)
    with pytest.raises(AbruptStop):
        executor.apply(change["change_id"])
    assert executor.recover(change["change_id"], "verify")["state"] == "rolled_back"
    assert path.read_bytes() == before


def test_restart_verifies_all_replaced_files_as_applied(tmp_path):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(before)

    def crash(point, _path=None):
        if point == "before_terminal":
            raise AbruptStop()

    executor, store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }], fault=crash)
    with pytest.raises(AbruptStop):
        executor.apply(change["change_id"])
    assert store.get("owner", "demo", change["change_id"])["state"] == "applying"
    result = executor.recover(change["change_id"], "verify")
    assert result["state"] == "applied"
    assert path.read_bytes() == b"after"


def test_partial_apply_requires_recovery_and_safe_rollback(tmp_path):
    for name in ("a.txt", "b.txt"):
        (tmp_path / name).write_bytes(name.encode())
    replacements = 0

    def crash(point, _path=None):
        nonlocal replacements
        if point == "after_file":
            replacements += 1
            if replacements == 1:
                raise AbruptStop()

    executor, store, change = setup_engine(tmp_path, [
        {"path": name, "operation": "modify", "base_sha256": sha(name.encode()),
         "content_utf8": f"new-{name}"} for name in ("a.txt", "b.txt")
    ], fault=crash)
    with pytest.raises(AbruptStop):
        executor.apply(change["change_id"])
    assert executor.recover(change["change_id"], "verify")["state"] == "recovery_required"
    assert executor.recover(change["change_id"], "rollback")["state"] == "rolled_back"
    assert (tmp_path / "a.txt").read_bytes() == b"a.txt"
    assert (tmp_path / "b.txt").read_bytes() == b"b.txt"
    assert store.transaction(change["change_id"], "apply")["phase"] == "rolled_back"


def test_rollback_never_overwrites_unknown_user_content(tmp_path):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(before)

    def crash(point, _path=None):
        if point == "before_terminal":
            raise AbruptStop()

    executor, _store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }], fault=crash)
    with pytest.raises(AbruptStop):
        executor.apply(change["change_id"])
    path.write_bytes(b"user edit")
    with pytest.raises(RecoveryRequired, match="RECOVERY_REQUIRED"):
        executor.recover(change["change_id"], "rollback")
    assert path.read_bytes() == b"user edit"


def test_revert_is_conditional_and_preserves_later_user_edits(tmp_path):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(before)
    executor, _store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }])
    assert executor.apply(change["change_id"])["state"] == "applied"
    assert executor.revert(change["change_id"])["state"] == "reverted"
    assert path.read_bytes() == before

    second_executor, second_store, second = setup_engine(tmp_path / "second", [{
        "path": "new.txt", "operation": "create", "base_sha256": None,
        "content_utf8": "created",
    }])
    assert second_executor.apply(second["change_id"])["state"] == "applied"
    (tmp_path / "second" / "new.txt").write_bytes(b"later edit")
    with pytest.raises(FileChanged, match="FILE_CHANGED"):
        second_executor.revert(second["change_id"])
    assert second_store.get("owner", "demo", second["change_id"])["state"] == "applied"
    assert (tmp_path / "second" / "new.txt").read_bytes() == b"later edit"


def test_restart_during_revert_uses_revert_transaction_evidence(tmp_path):
    before = b"before"
    path = tmp_path / "target.txt"
    path.write_bytes(before)
    executor, store, change = setup_engine(tmp_path, [{
        "path": "target.txt", "operation": "modify", "base_sha256": sha(before),
        "content_utf8": "after",
    }])
    assert executor.apply(change["change_id"])["state"] == "applied"

    def crash(point, _path=None):
        if point == "before_revert_terminal":
            raise AbruptStop()

    executor.fault = crash
    with pytest.raises(AbruptStop):
        executor.revert(change["change_id"])
    assert store.get("owner", "demo", change["change_id"])["state"] == "reverting"
    assert executor.recover(change["change_id"], "verify")["state"] == "reverted"
    assert path.read_bytes() == before


def test_recovery_required_blocks_another_write_in_the_same_project(tmp_path):
    for name in ("a.txt", "b.txt", "other.txt"):
        (tmp_path / name).write_bytes(name.encode())
    replacements = 0

    def crash(point, _path=None):
        nonlocal replacements
        if point == "after_file":
            replacements += 1
            if replacements == 1:
                raise AbruptStop()

    executor, store, first = setup_engine(tmp_path, [
        {"path": name, "operation": "modify", "base_sha256": sha(name.encode()),
         "content_utf8": f"new-{name}"} for name in ("a.txt", "b.txt")
    ], fault=crash)
    with pytest.raises(AbruptStop):
        executor.apply(first["change_id"])
    assert executor.recover(first["change_id"], "verify")["state"] == "recovery_required"
    second = store.create("owner", {
        "project_id": "demo", "request_id": "request-2", "summary": "other",
        "files": [{"path": "other.txt", "operation": "modify",
                   "base_sha256": sha(b"other.txt"), "content_utf8": "new-other"}],
    })
    with pytest.raises(Exception, match="RECOVERY_REQUIRED"):
        executor.apply(second["change_id"])
    assert (tmp_path / "other.txt").read_bytes() == b"other.txt"
