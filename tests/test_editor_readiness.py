from __future__ import annotations

import hashlib

import pytest
from cryptography.fernet import Fernet
from starlette.testclient import TestClient

from project_mcp.config import Settings


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class MemoryKeyProvider:
    def __init__(self):
        self.key = Fernet.generate_key()

    def get_key(self):
        return self.key


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_runtime(tmp_path, clock):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore
    from project_mcp.editor_readiness import EditorReadiness
    from project_mcp.server import Runtime

    (tmp_path / "app.py").write_bytes(b"before\n")
    settings = Settings(
        projects=[{
            "id": "demo", "root": tmp_path, "mode": "propose",
            "apply_local_enabled": True,
        }],
        admin_token="a" * 40,
        mcp_token="m" * 40,
        state_dir=tmp_path / ".local",
    )
    content = ProtectedContentStore(tmp_path / ".state" / "content", MemoryKeyProvider())
    store = ChangeStore(tmp_path / ".state" / "changes.db", content)
    readiness = EditorReadiness(now=clock, session_ttl_seconds=10, lease_ttl_seconds=5)
    return Runtime(settings, change_store=store, editor_readiness=readiness), store


def submit(runtime, store, request_id="request-1"):
    from project_mcp.changes.service import ChangeService

    return ChangeService(runtime.workspace, store).submit("owner", {
        "project_id": "demo",
        "request_id": request_id,
        "summary": "Update app",
        "files": [{
            "path": "app.py", "operation": "modify",
            "base_sha256": sha(b"before\n"), "content_utf8": "after\n",
        }],
    })


def registration(change, *, dirty=False, review=True):
    return {
        "project_id": "demo",
        "documents": [{"path": "app.py", "version": 3, "dirty": dirty}],
        "active_review": ({
            "change_id": change["change_id"],
            "manifest_sha256": change["manifest_sha256"],
        } if review else None),
    }


def test_unknown_dirty_changed_and_expired_sessions_fail_closed(tmp_path):
    from project_mcp.editor_readiness import EditorReadiness, ReadinessBlocked

    clock = Clock()
    readiness = EditorReadiness(now=clock, session_ttl_seconds=10, lease_ttl_seconds=5)
    args = ("demo", "change-1", "window-a", "a" * 64, ["app.py"])
    with pytest.raises(ReadinessBlocked, match="EDITOR_UNAVAILABLE"):
        readiness.issue(*args)

    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 1, "dirty": True}],
        "active_review": {"change_id": "change-1", "manifest_sha256": "a" * 64},
    })
    with pytest.raises(ReadinessBlocked, match="EDITOR_DIRTY"):
        readiness.issue(*args)

    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 2, "dirty": False}],
        "active_review": {"change_id": "change-1", "manifest_sha256": "a" * 64},
    })
    lease = readiness.issue(*args)
    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 3, "dirty": True}],
        "active_review": {"change_id": "change-1", "manifest_sha256": "a" * 64},
    })
    with pytest.raises(ReadinessBlocked, match="EDITOR_DIRTY"):
        readiness.consume(lease["lease_id"], *args[:-1], paths=args[-1])

    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 4, "dirty": False}],
        "active_review": {"change_id": "change-1", "manifest_sha256": "a" * 64},
    })
    lease = readiness.issue(*args)
    clock.value += 6
    with pytest.raises(ReadinessBlocked, match="LEASE_EXPIRED"):
        readiness.consume(lease["lease_id"], *args[:-1], paths=args[-1])


def test_all_relevant_windows_participate_and_offline_window_blocks(tmp_path):
    from project_mcp.editor_readiness import EditorReadiness, ReadinessBlocked

    clock = Clock()
    readiness = EditorReadiness(now=clock, session_ttl_seconds=10, lease_ttl_seconds=5)
    review = {"change_id": "change-1", "manifest_sha256": "b" * 64}
    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 1, "dirty": False}],
        "active_review": review,
    })
    readiness.update("window-b", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 8, "dirty": False}],
        "active_review": None,
    })
    clock.value += 8
    readiness.update("window-a", {
        "project_id": "demo", "documents": [{"path": "app.py", "version": 1, "dirty": False}],
        "active_review": review,
    })
    clock.value += 3
    with pytest.raises(ReadinessBlocked, match="EDITOR_UNAVAILABLE.*window-b"):
        readiness.issue("demo", "change-1", "window-a", "b" * 64, ["app.py"])


def test_real_local_routes_apply_once_after_fresh_review_lease(tmp_path):
    from project_mcp.server import create_admin_app

    clock = Clock()
    runtime, store = make_runtime(tmp_path, clock)
    change = submit(runtime, store)
    headers = {"Authorization": "Bearer " + runtime.settings.admin_token}
    with TestClient(
        create_admin_app(runtime), base_url="http://127.0.0.1:8766", headers=headers,
    ) as client:
        assert client.put(
            "/api/editor-readiness/window-a", json=registration(change),
        ).status_code == 200
        lease = client.post(f"/api/changes/{change['change_id']}/readiness", json={
            "review_session_id": "window-a",
            "manifest_sha256": change["manifest_sha256"],
        })
        assert lease.status_code == 200
        body = {
            "operation_id": "apply-1", "expected_revision": 1,
            "review_session_id": "window-a",
            "manifest_sha256": change["manifest_sha256"],
            "lease_id": lease.json()["lease_id"],
        }
        first = client.post(f"/api/changes/{change['change_id']}/apply", json=body)
        second = client.post(f"/api/changes/{change['change_id']}/apply", json=body)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()
        assert first.json()["state"] == "applied"
        assert (tmp_path / "app.py").read_bytes() == b"after\n"


def test_dirty_or_expired_lease_keeps_pending_and_disk_change_becomes_conflict(tmp_path):
    from project_mcp.server import create_admin_app

    clock = Clock()
    runtime, store = make_runtime(tmp_path, clock)
    headers = {"Authorization": "Bearer " + runtime.settings.admin_token}
    with TestClient(
        create_admin_app(runtime), base_url="http://127.0.0.1:8766", headers=headers,
    ) as client:
        dirty = submit(runtime, store, "dirty")
        client.put("/api/editor-readiness/window-a", json=registration(dirty, dirty=True))
        blocked = client.post(f"/api/changes/{dirty['change_id']}/readiness", json={
            "review_session_id": "window-a", "manifest_sha256": dirty["manifest_sha256"],
        })
        assert blocked.status_code == 409
        assert blocked.json()["error_code"] == "EDITOR_DIRTY"
        assert store.get("owner", "demo", dirty["change_id"])["state"] == "pending_review"

        changed = submit(runtime, store, "changed")
        (tmp_path / "app.py").write_bytes(b"user edit\n")
        client.put("/api/editor-readiness/window-a", json=registration(changed))
        conflict = client.post(f"/api/changes/{changed['change_id']}/readiness", json={
            "review_session_id": "window-a", "manifest_sha256": changed["manifest_sha256"],
        })
        assert conflict.status_code == 409
        assert conflict.json()["error_code"] == "FILE_CHANGED"
        assert store.get("owner", "demo", changed["change_id"])["state"] == "conflict"
        assert (tmp_path / "app.py").read_bytes() == b"user edit\n"


def test_revert_requires_fresh_clean_editor_lease_and_reports_undo_window(tmp_path):
    from project_mcp.server import create_admin_app

    clock = Clock()
    runtime, store = make_runtime(tmp_path, clock)
    change = submit(runtime, store)
    headers = {"Authorization": "Bearer " + runtime.settings.admin_token}
    with TestClient(
        create_admin_app(runtime), base_url="http://127.0.0.1:8766", headers=headers,
    ) as client:
        client.put("/api/editor-readiness/window-a", json=registration(change))
        lease = client.post(f"/api/changes/{change['change_id']}/readiness", json={
            "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
        }).json()
        applied = client.post(f"/api/changes/{change['change_id']}/apply", json={
            "operation_id": "apply", "expected_revision": 1,
            "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
            "lease_id": lease["lease_id"],
        }).json()
        detail = client.get(f"/api/changes/{change['change_id']}").json()
        assert detail["undo_available"] is True
        assert detail["undo_expires_at"]

        client.put(
            "/api/editor-readiness/window-a", json=registration(change, dirty=True),
        )
        blocked = client.post(f"/api/changes/{change['change_id']}/readiness", json={
            "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
        })
        assert blocked.status_code == 409
        assert (tmp_path / "app.py").read_bytes() == b"after\n"

        client.put("/api/editor-readiness/window-a", json=registration(change))
        lease = client.post(f"/api/changes/{change['change_id']}/readiness", json={
            "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
        }).json()
        reverted = client.post(f"/api/changes/{change['change_id']}/revert", json={
            "operation_id": "revert", "expected_revision": applied["revision"],
            "review_session_id": "window-a", "manifest_sha256": change["manifest_sha256"],
            "lease_id": lease["lease_id"],
        })
        assert reverted.status_code == 200
        assert reverted.json()["state"] == "reverted"
        assert (tmp_path / "app.py").read_bytes() == b"before\n"
