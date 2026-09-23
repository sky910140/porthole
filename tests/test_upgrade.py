from __future__ import annotations

import gc
import json
import sqlite3

import pytest
from cryptography.fernet import Fernet

from project_mcp.changes.content import ProtectedContentStore, StorageUnavailable
from project_mcp.changes.store import ChangeStore
from project_mcp.config import migrate_config
from project_mcp.upgrade import UpgradeError, UpgradeManager


class MemoryKey:
    def __init__(self):
        self.key = Fernet.generate_key()

    def get_key(self):
        return self.key


def setup_upgrade(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"projects": [{"id": "demo", "root": str(root)}]}))
    state = tmp_path / "state"
    content = ProtectedContentStore(state / "changes" / "content", MemoryKey())
    store = ChangeStore(state / "changes" / "changes.db", content)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "ai-zhagan.exe").write_bytes(b"old-runtime")
    manager = UpgradeManager(config, state, runtime, content_store=content, is_running=lambda: False)
    return manager, store, content, config, root


def test_config_migrations_are_explicit_and_preserve_project_scope(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    source = {"projects": [{"id": "demo", "root": str(root)}]}
    v03 = migrate_config(source, "0.2", "0.3")
    assert v03["config_version"] == "0.3"
    assert v03["projects"][0]["mode"] == "read_only"
    v10 = migrate_config(v03, "0.3", "1.0")
    assert v10["config_version"] == "1.0"
    assert v10["projects"][0]["apply_local_enabled"] is False
    assert migrate_config(source, "0.2", "1.0") == v10
    with pytest.raises(ValueError):
        migrate_config(v10, "1.0", "0.2")


def test_snapshot_uses_sqlite_backup_and_verified_blobs(tmp_path):
    manager, store, content, config, root = setup_upgrade(tmp_path)
    blob = content.put_bytes(b"private-content")
    result = store.create("owner", {
        "project_id": "demo", "request_id": "r1", "summary": "test",
        "files": [{"path": "new.txt", "operation": "create", "content_utf8": "hello"}],
    })
    snapshot_id = manager.prepare_upgrade("0.3")
    snapshot = manager.snapshot_root / snapshot_id
    assert (snapshot / "runtime" / "ai-zhagan.exe").read_bytes() == b"old-runtime"
    assert sqlite3.connect(snapshot / "changes.db").execute(
        "SELECT COUNT(*) FROM changes"
    ).fetchone()[0] == 1
    assert (snapshot / "content" / "objects" / f"{blob}.blob").is_file()
    assert (snapshot / "config.json").read_bytes() == config.read_bytes()
    assert (root / "new.txt").exists() is False
    assert result["state"] == "pending_review"
    assert (manager.state_dir / "upgrade-in-progress.json").is_file()


def test_upgrade_blocks_active_transactions_and_corrupt_blobs(tmp_path):
    manager, store, content, _config, _root = setup_upgrade(tmp_path)
    store.create("owner", {
        "project_id": "demo", "request_id": "r1", "summary": "test",
        "files": [{"path": "new.txt", "operation": "create", "content_utf8": "hello"}],
    })
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("UPDATE changes SET state='recovery_required'")
    with pytest.raises(UpgradeError, match="recovery_required"):
        manager.prepare_upgrade("0.3")
    assert not (manager.state_dir / "upgrade-in-progress.json").exists()
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("UPDATE changes SET state='pending_review'")
    blob_id = next(content.iter_blob_ids())
    (content.objects / f"{blob_id}.blob").write_bytes(b"corrupt")
    with pytest.raises(StorageUnavailable):
        manager.prepare_upgrade("0.3")


def test_failed_upgrade_restores_snapshot_but_new_changes_block_rollback(tmp_path):
    manager, store, _content, config, root = setup_upgrade(tmp_path)
    snapshot_id = manager.prepare_upgrade("0.3")
    store = None
    gc.collect()  # A stopped service has no open database handles on Windows.
    config.write_text("broken")
    (manager.runtime_dir / "ai-zhagan.exe").write_bytes(b"broken-runtime")
    manager.restore_snapshot(snapshot_id)
    assert json.loads(config.read_text())["projects"][0]["id"] == "demo"
    assert (manager.runtime_dir / "ai-zhagan.exe").read_bytes() == b"old-runtime"
    assert not (manager.state_dir / "upgrade-in-progress.json").exists()
    assert root.is_dir()

    snapshot_id = manager.prepare_upgrade("0.3")
    store = ChangeStore(manager.db_path, _content)
    store.create("owner", {
        "project_id": "demo", "request_id": "r2", "summary": "test",
        "files": [{"path": "new.txt", "operation": "create", "content_utf8": "hello"}],
    })
    with pytest.raises(UpgradeError, match="new changes"):
        manager.restore_snapshot(snapshot_id)


def test_old_storage_reader_refuses_newer_schema(tmp_path):
    _manager, store, content, _config, _root = setup_upgrade(tmp_path)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("PRAGMA user_version=99")
    with pytest.raises(StorageUnavailable, match="newer"):
        ChangeStore(store.db_path, content)


def test_complete_requires_health_and_active_marker_is_preserved(tmp_path):
    manager, _store, _content, config, _root = setup_upgrade(tmp_path)
    snapshot_id = manager.prepare_upgrade("0.3")
    with pytest.raises(FileExistsError):
        manager.prepare_upgrade("0.3")
    assert manager.marker.is_file()
    with pytest.raises(UpgradeError, match="health"):
        manager.complete_upgrade(snapshot_id, health_check=lambda: False)
    assert manager.marker.is_file()
    assert json.loads(config.read_text())["config_version"] == "0.3"
    manager.complete_upgrade(snapshot_id, health_check=lambda: True)
    assert not manager.marker.exists()


def test_missing_referenced_blob_blocks_snapshot(tmp_path):
    manager, store, content, _config, _root = setup_upgrade(tmp_path)
    store.create("owner", {
        "project_id": "demo", "request_id": "r1", "summary": "test",
        "files": [{"path": "new.txt", "operation": "create", "content_utf8": "hello"}],
    })
    blob_id = next(content.iter_blob_ids())
    (content.objects / f"{blob_id}.blob").unlink()
    with pytest.raises(StorageUnavailable):
        manager.prepare_upgrade("0.3")


def test_restore_does_not_require_damaged_new_content_key(tmp_path):
    manager, _store, content, _config, _root = setup_upgrade(tmp_path)
    snapshot_id = manager.prepare_upgrade("0.3")
    content.marker.write_bytes(b"damaged")
    manager.content_store = None
    manager.restore_snapshot(snapshot_id)
    assert content.marker.read_bytes() != b"damaged"


def test_tampered_snapshot_cannot_be_restored(tmp_path):
    manager, _store, _content, _config, _root = setup_upgrade(tmp_path)
    snapshot_id = manager.prepare_upgrade("0.3")
    (manager.snapshot_root / snapshot_id / "runtime" / "ai-zhagan.exe").write_bytes(b"tampered")
    with pytest.raises(UpgradeError, match="checksum"):
        manager.restore_snapshot(snapshot_id)


def test_restore_drops_stale_wal_sidecars(tmp_path):
    manager, _store, _content, _config, _root = setup_upgrade(tmp_path)
    snapshot_id = manager.prepare_upgrade("0.3")
    wal = manager.db_path.with_name(manager.db_path.name + "-wal")
    shm = manager.db_path.with_name(manager.db_path.name + "-shm")
    wal.write_bytes(b"")
    shm.write_bytes(b"")
    manager.restore_snapshot(snapshot_id)
    assert not wal.exists()
    assert not shm.exists()
