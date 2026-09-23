from __future__ import annotations

import hashlib

import pytest
from cryptography.fernet import Fernet


class Key:
    def __init__(self):
        self.value = Fernet.generate_key()

    def get_key(self):
        return self.value


@pytest.mark.asyncio
async def test_status_capacity_remains_available_when_read_queue_is_saturated():
    from project_mcp.runtime_limits import BusyError, RuntimeLimits

    limits = RuntimeLimits(read_concurrency=1, read_queue=0, status_concurrency=1)
    await limits.read.acquire()
    with pytest.raises(BusyError):
        await limits.read.acquire()
    await limits.status.acquire()
    assert limits.status.active == 1
    limits.status.release()
    limits.read.release()


def test_disk_full_and_database_corruption_fail_closed_without_reset(tmp_path):
    from project_mcp.changes.content import ProtectedContentStore, QuotaExceeded, StorageUnavailable
    from project_mcp.changes.store import ChangeStore

    content = ProtectedContentStore(tmp_path / "small", Key(), max_bytes=100)
    with pytest.raises(QuotaExceeded):
        content.put_bytes(b"x" * 200)

    database = tmp_path / "corrupt.db"
    database.write_bytes(b"not sqlite")
    healthy_content = ProtectedContentStore(tmp_path / "content", Key())
    with pytest.raises(StorageUnavailable):
        ChangeStore(database, healthy_content)
    assert database.read_bytes() == b"not sqlite"


def test_permission_revocation_after_proposal_prevents_local_write(tmp_path):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore
    from project_mcp.config import Settings
    from project_mcp.server import Runtime

    target = tmp_path / "app.py"
    target.write_bytes(b"before")
    settings = Settings(
        projects=[{
            "id": "demo", "root": tmp_path, "mode": "propose",
            "apply_local_enabled": True,
        }], admin_token="a" * 40, mcp_token="m" * 40,
        state_dir=tmp_path / ".local",
    )
    store = ChangeStore(
        tmp_path / ".state" / "changes.db",
        ProtectedContentStore(tmp_path / ".state" / "content", Key()),
    )
    runtime = Runtime(settings, change_store=store)
    service = runtime.get_change_service()
    change = service.submit("owner", {
        "project_id": "demo", "request_id": "one", "summary": "change",
        "files": [{
            "path": "app.py", "operation": "modify",
            "base_sha256": hashlib.sha256(b"before").hexdigest(),
            "content_utf8": "after",
        }],
    })
    runtime.update_project_policy("demo", {"apply_local_enabled": False})
    with pytest.raises(PermissionError):
        service.issue_readiness(change["change_id"], {
            "review_session_id": "window", "manifest_sha256": change["manifest_sha256"],
        })
    assert target.read_bytes() == b"before"


def test_response_loss_retry_returns_persisted_apply_result(tmp_path):
    from test_editor_readiness import Clock, make_runtime, registration, submit

    clock = Clock()
    runtime, store = make_runtime(tmp_path, clock)
    change = submit(runtime, store)
    service = runtime.get_change_service()
    runtime.editor_readiness.update("window-a", registration(change))
    lease = service.issue_readiness(change["change_id"], {
        "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
    })
    request = {
        "operation_id": "lost-response", "expected_revision": 1,
        "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
        "lease_id": lease["lease_id"],
    }
    first = service.apply_reviewed(change["change_id"], request)
    second = service.apply_reviewed(change["change_id"], request)
    assert first == second
    assert first["state"] == "applied"
    assert (tmp_path / "app.py").read_bytes() == b"after\n"
