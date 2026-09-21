from __future__ import annotations

import hashlib

import httpx
import pytest
from cryptography.fernet import Fernet
from fastmcp import Client
from fastmcp.server.auth import AccessToken
from starlette.testclient import TestClient

from project_mcp.config import Settings


class MemoryKeyProvider:
    def __init__(self):
        self.key = Fernet.generate_key()

    def get_key(self) -> bytes:
        return self.key


def make_store(tmp_path):
    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore

    content = ProtectedContentStore(tmp_path / "protected", MemoryKeyProvider())
    return ChangeStore(tmp_path / "changes.db", content)


def make_settings(tmp_path, *, mode="propose"):
    (tmp_path / "app.py").write_text("print('old')\n", encoding="utf8")
    return Settings(
        projects=[{"id": "demo", "root": tmp_path, "mode": mode}],
        admin_token="a" * 40,
        mcp_token="m" * 40,
        state_dir=tmp_path / ".local",
    )


def change_request(*, request_id="request-1", content="print('new')\n"):
    old = hashlib.sha256(b"print('old')\n").hexdigest()
    return {
        "project_id": "demo",
        "request_id": request_id,
        "summary": "Update the greeting",
        "files": [{
            "path": "app.py",
            "operation": "modify",
            "base_sha256": old,
            "content_utf8": content,
        }],
    }


def test_service_submits_pending_without_writing_and_isolates_identity(tmp_path):
    from project_mcp.changes.service import ChangeService
    from project_mcp.changes.store import RecordUnavailable
    from project_mcp.server import Runtime

    store = make_store(tmp_path / "state")
    runtime = Runtime(make_settings(tmp_path), change_store=store)
    service = ChangeService(runtime.workspace, store)

    result = service.submit("owner-1", change_request())
    assert result["state"] == "pending_review"
    assert result["local_files_changed"] is False
    assert (tmp_path / "app.py").read_text(encoding="utf8") == "print('old')\n"
    assert service.submit("owner-1", change_request())["change_id"] == result["change_id"]
    assert service.get("owner-1", "demo", result["change_id"])["revision"] == 1
    with pytest.raises(RecordUnavailable):
        service.get("owner-2", "demo", result["change_id"])


def test_service_enforces_project_policy_and_bounded_diff(tmp_path):
    from project_mcp.changes.service import ChangeService
    from project_mcp.server import Runtime

    store = make_store(tmp_path / "state")
    readonly = Runtime(make_settings(tmp_path, mode="read_only"), change_store=store)
    with pytest.raises(PermissionError):
        ChangeService(readonly.workspace, store).submit("owner", change_request())

    runtime = Runtime(make_settings(tmp_path), change_store=store)
    service = ChangeService(runtime.workspace, store, max_diff_bytes=4_096)
    created = service.submit("owner", change_request(content="x = 1\n" * 20_000))
    diff = service.diff("owner", "demo", created["change_id"])
    assert diff["source"] == "change_proposal"
    assert diff["truncated"] is True
    assert diff["truncation_reason"] == "output_limit"
    assert len(diff["diff"].encode("utf8")) <= 4_096
    assert "content_utf8" not in str(service.get("owner", "demo", created["change_id"]))


@pytest.mark.asyncio
async def test_tool_contract_actor_is_not_input_and_proposal_is_stateful(tmp_path, monkeypatch):
    from project_mcp.server import Runtime, create_mcp

    store = make_store(tmp_path / "state")
    runtime = Runtime(make_settings(tmp_path), change_store=store)
    monkeypatch.setattr("project_mcp.server.current_actor_id", lambda scope: "owner-1")
    async with Client(create_mcp(runtime)) as client:
        tools = {tool.name: tool for tool in await client.list_tools()}
        assert {"propose_changes", "get_change_status", "get_change_diff"} <= tools.keys()
        assert "actor_id" not in tools["propose_changes"].inputSchema["properties"]
        assert tools["propose_changes"].annotations.readOnlyHint is False
        assert tools["propose_changes"].annotations.idempotentHint is True
        assert tools["get_change_status"].annotations.readOnlyHint is True

        submitted = await client.call_tool("propose_changes", change_request())
        assert submitted.data["state"] == "pending_review"
        assert submitted.data["local_files_changed"] is False
        queried = await client.call_tool("get_change_status", {
            "project_id": "demo", "change_id": submitted.data["change_id"],
        })
        assert queried.data["change_id"] == submitted.data["change_id"]
        assert (tmp_path / "app.py").read_text(encoding="utf8") == "print('old')\n"


def test_authenticated_actor_comes_from_token_context(monkeypatch):
    from project_mcp.auth import current_actor_id

    token = AccessToken(
        token="secret", client_id="ignored-client", scopes=["project:read", "project:propose"],
        claims={"sub": "github-owner-123"},
    )
    monkeypatch.setattr("project_mcp.auth.get_access_token", lambda: token)
    assert current_actor_id("project:propose") == "github-owner-123"
    monkeypatch.setattr(
        "project_mcp.auth.get_access_token",
        lambda: AccessToken(token="secret", client_id="client", scopes=["project:read"], claims={}),
    )
    with pytest.raises(PermissionError, match="PROJECT_FORBIDDEN"):
        current_actor_id("project:propose")


@pytest.mark.asyncio
async def test_remote_http_has_no_apply_approve_or_recovery_routes(tmp_path):
    from project_mcp.server import Runtime, create_mcp

    app = create_mcp(Runtime(make_settings(tmp_path), change_store=make_store(tmp_path / "state"))).http_app(
        path="/mcp", stateless_http=True,
    )
    async with app.lifespan(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost",
    ) as client:
        for path in ("/api/changes/x/apply", "/api/changes/x/approve", "/api/recovery"):
            assert (await client.post(path, json={})).status_code == 404


def test_local_history_survives_remote_auth_loss_and_apply_is_idempotently_blocked(tmp_path):
    from project_mcp.changes.service import ChangeService
    from project_mcp.server import Runtime, create_admin_app

    settings = make_settings(tmp_path)
    store = make_store(tmp_path / "state")
    runtime = Runtime(settings, change_store=store)
    change = ChangeService(runtime.workspace, store).submit("owner", change_request())
    headers = {"Authorization": "Bearer " + settings.admin_token}
    with TestClient(
        create_admin_app(runtime), base_url="http://127.0.0.1:8766", headers=headers,
    ) as client:
        history = client.get("/api/changes")
        assert history.status_code == 200
        assert history.json()["changes"][0]["change_id"] == change["change_id"]
        body = {"operation_id": "apply-1", "expected_revision": 1}
        first = client.post(f"/api/changes/{change['change_id']}/apply", json=body)
        second = client.post(f"/api/changes/{change['change_id']}/apply", json=body)
        assert first.status_code == second.status_code == 409
        assert first.json() == second.json()
        assert first.json()["error_code"] == "EDITOR_UNAVAILABLE"
        assert (tmp_path / "app.py").read_text(encoding="utf8") == "print('old')\n"


def test_change_storage_failure_does_not_break_read_tools(tmp_path, monkeypatch):
    from project_mcp.changes.content import StorageUnavailable
    from project_mcp.server import Runtime, create_mcp

    runtime = Runtime(make_settings(tmp_path))
    monkeypatch.setattr(runtime, "get_change_service", lambda: (_ for _ in ()).throw(
        StorageUnavailable("secret storage detail")))
    monkeypatch.setattr("project_mcp.server.current_actor_id", lambda scope: "owner")

    async def exercise():
        async with Client(create_mcp(runtime)) as client:
            read = await client.call_tool("read_file", {"project_id": "demo", "path": "app.py"})
            failed = await client.call_tool("propose_changes", change_request(), raise_on_error=False)
            assert "old" in str(read.data)
            assert failed.is_error
            assert "STORAGE_UNAVAILABLE" in str(failed)
            assert "secret storage detail" not in str(failed)

    import asyncio
    asyncio.run(exercise())


def test_content_key_failure_keeps_local_metadata_history_available(tmp_path, monkeypatch):
    from project_mcp.changes.content import ProtectedContentStore, StorageUnavailable
    from project_mcp.changes.service import ChangeService
    from project_mcp.changes.store import ChangeStore
    from project_mcp.server import Runtime, create_admin_app

    settings = make_settings(tmp_path)
    root = settings.state_dir / "changes"
    store = ChangeStore(
        root / "changes.db", ProtectedContentStore(root / "content", MemoryKeyProvider()),
    )
    created = ChangeService(Runtime(settings, change_store=store).workspace, store).submit(
        "owner", change_request(),
    )
    runtime = Runtime(settings)
    monkeypatch.setattr(
        "project_mcp.server.KeyringKeyProvider.get_key",
        lambda self: (_ for _ in ()).throw(StorageUnavailable("key unavailable")),
    )
    headers = {"Authorization": "Bearer " + settings.admin_token}
    with TestClient(
        create_admin_app(runtime), base_url="http://127.0.0.1:8766", headers=headers,
    ) as client:
        history = client.get("/api/changes")
        assert history.status_code == 200
        assert history.json()["changes"][0]["change_id"] == created["change_id"]
        apply = client.post(
            f"/api/changes/{created['change_id']}/apply",
            json={"operation_id": "blocked", "expected_revision": 1},
        )
        assert apply.status_code == 503
