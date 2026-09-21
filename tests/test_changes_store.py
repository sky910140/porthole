from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet


class MemoryKeyProvider:
    def __init__(self, key: bytes | None = None):
        self.key = key or Fernet.generate_key()

    def get_key(self) -> bytes:
        if self.key is None:
            raise RuntimeError("key unavailable")
        return self.key


def request(request_id="request-001", content="# Demo\n"):
    return {
        "project_id": "demo",
        "request_id": request_id,
        "summary": "新增说明",
        "files": [{
            "path": "README.md", "operation": "create",
            "base_sha256": None, "content_utf8": content,
        }],
    }


def stores(tmp_path, **kwargs):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore

    key = kwargs.pop("key_provider", MemoryKeyProvider())
    content = ProtectedContentStore(tmp_path / "content", key, **kwargs.pop("content_options", {}))
    return ChangeStore(tmp_path / "changes.db", content, **kwargs), content, key


def test_content_is_encrypted_integrity_checked_and_key_loss_fails_closed(tmp_path):
    from project_mcp.changes.content import ProtectedContentStore, StorageUnavailable

    provider = MemoryKeyProvider()
    content = ProtectedContentStore(tmp_path / "content", provider)
    blob_id = content.put_bytes(b"plain-secret-value")
    assert content.get_bytes(blob_id) == b"plain-secret-value"
    assert all(b"plain-secret-value" not in path.read_bytes() for path in tmp_path.rglob("*") if path.is_file())

    provider.key = Fernet.generate_key()
    with pytest.raises(StorageUnavailable):
        ProtectedContentStore(tmp_path / "content", provider)
    assert list((tmp_path / "content" / "objects").iterdir())


def test_same_request_is_idempotent_across_restart_and_conflicts_on_new_content(tmp_path):
    from project_mcp.changes.store import ChangeStore, IdempotencyConflict

    store, content, _key = stores(tmp_path)
    first = store.create("owner", request())
    assert first["state"] == "pending_review"
    assert store.create("owner", request())["change_id"] == first["change_id"]
    reopened = ChangeStore(tmp_path / "changes.db", content)
    assert reopened.create("owner", request())["change_id"] == first["change_id"]
    with pytest.raises(IdempotencyConflict):
        reopened.create("owner", request(content="# Different\n"))


def test_concurrent_retry_creates_one_record_and_cross_actor_cannot_read_it(tmp_path):
    from project_mcp.changes.store import RecordUnavailable

    store, _content, _key = stores(tmp_path)
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _index: store.create("owner", request()), range(100)))
    assert len({item["change_id"] for item in results}) == 1
    result = results[0]
    assert store.get("owner", "demo", result["change_id"])["revision"] == 1
    with pytest.raises(RecordUnavailable):
        store.get("other", "demo", result["change_id"])
    assert store.count_changes() == 1


def test_manifest_is_immutable_and_database_does_not_contain_plain_content(tmp_path):
    from project_mcp.changes.store import InvalidTransition

    store, _content, _key = stores(tmp_path)
    result = store.create("owner", request(content="unique-plain-content"))
    files = store.files("owner", "demo", result["change_id"])
    assert files[0]["content_sha256"]
    assert "content_utf8" not in files[0]
    assert b"unique-plain-content" not in (tmp_path / "changes.db").read_bytes()
    rejected = store.transition(
        "owner", "demo", result["change_id"],
        expected_revision=1, expected_states={"pending_review"}, new_state="rejected",
        transaction_kind="reject",
    )
    assert rejected["revision"] == 2
    with pytest.raises(InvalidTransition):
        store.transition(
            "owner", "demo", result["change_id"],
            expected_revision=1, expected_states={"pending_review"}, new_state="rejected",
        )
    assert store.files("owner", "demo", result["change_id"])[0]["content_sha256"] == files[0]["content_sha256"]


def test_limits_validate_before_storage_and_quota_stops_new_pending_changes(tmp_path):
    from project_mcp.changes.content import QuotaExceeded
    from project_mcp.changes.models import ChangeRequest

    with pytest.raises(ValueError):
        ChangeRequest.model_validate(request(content="x" * (1024 * 1024 + 1)))
    with pytest.raises(ValueError):
        ChangeRequest.model_validate({**request(), "files": request()["files"] * 21})

    store, content, _key = stores(tmp_path, max_pending=1)
    store.create("owner", request("one"))
    with pytest.raises(QuotaExceeded):
        store.create("owner", request("two"))
    assert len(list(content.iter_blob_ids())) == 1

    small_content_options = {"max_bytes": 100}
    _store2, content2, _key2 = stores(tmp_path / "small", content_options=small_content_options)
    with pytest.raises(QuotaExceeded):
        content2.put_bytes(b"x" * 200)


def test_database_failure_leaves_recoverable_orphan_and_cleanup_preserves_references(tmp_path):
    def fail(point):
        if point == "before_database_insert":
            raise RuntimeError("injected database failure")

    store, content, key = stores(tmp_path, fault_injector=fail)
    with pytest.raises(RuntimeError, match="injected"):
        store.create("owner", request())
    assert len(list(content.iter_blob_ids())) == 1

    healthy = type(store)(tmp_path / "changes.db", content)
    assert healthy.cleanup_orphans(grace_seconds=0) == 1
    created = healthy.create("owner", request())
    assert healthy.cleanup_orphans(grace_seconds=0) == 0
    assert healthy.files("owner", "demo", created["change_id"])[0]["content_blob_id"]
    assert key.key


def test_cleanup_expires_pending_but_never_removes_unresolved_recovery_content(tmp_path):
    store, content, _key = stores(tmp_path)
    old = datetime.now(UTC) - timedelta(days=40)
    first = store.create("owner", request("expiring"), now=old)
    second = store.create("owner", request("recovery"), now=old)
    store.transition(
        "owner", "demo", second["change_id"], expected_revision=1,
        expected_states={"pending_review"}, new_state="recovery_required",
        transaction_kind="apply", now=old,
    )
    report = store.cleanup(now=datetime.now(UTC))
    assert report["expired"] == 1
    assert store.get("owner", "demo", first["change_id"])["state"] == "expired"
    assert store.get("owner", "demo", second["change_id"])["state"] == "recovery_required"
    assert content.get_bytes(store.files("owner", "demo", second["change_id"])[0]["content_blob_id"])


def test_snapshot_and_reference_check_are_consistent(tmp_path):
    store, _content, _key = stores(tmp_path)
    store.create("owner", request())
    manifest = store.backup_to(tmp_path / "backup.db")
    assert (tmp_path / "backup.db").is_file()
    assert manifest["integrity"] == "ok"
    assert len(manifest["referenced_blobs"]) == 1
    assert store.verify_references() == {"missing": [], "orphaned": []}
    json.dumps(manifest)


def test_operation_records_are_idempotent_and_reject_parameter_reuse(tmp_path):
    from project_mcp.changes.store import IdempotencyConflict

    store, _content, _key = stores(tmp_path)
    change = store.create("owner", request())
    parameters = {"expected_revision": 1, "kind": "reject"}
    assert store.begin_operation(
        "operation-1", change["change_id"], "owner", "reject", parameters,
    ) is None
    result = {"change_id": change["change_id"], "state": "rejected"}
    store.finish_operation("operation-1", result)
    assert store.begin_operation(
        "operation-1", change["change_id"], "owner", "reject", parameters,
    ) == result
    with pytest.raises(IdempotencyConflict):
        store.begin_operation(
            "operation-1", change["change_id"], "owner", "reject",
            {"expected_revision": 2, "kind": "reject"},
        )


def test_corrupt_database_is_not_replaced(tmp_path):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore, StorageUnavailable

    database = tmp_path / "changes.db"
    database.write_bytes(b"not a sqlite database")
    content = ProtectedContentStore(tmp_path / "content", MemoryKeyProvider())
    with pytest.raises(StorageUnavailable):
        ChangeStore(database, content)
    assert database.read_bytes() == b"not a sqlite database"
