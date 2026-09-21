import json

import httpx
import pytest
from starlette.testclient import TestClient

from project_mcp.config import Settings


def settings(tmp_path):
    (tmp_path / "main.py").write_text("print('saved')\n", encoding="utf8")
    return Settings(projects=[{"id": "demo", "root": tmp_path}],
                    admin_token="a" * 40, mcp_token="m" * 40, state_dir=tmp_path / ".local")


def test_admin_requires_token_origin_and_keeps_secrets_out(tmp_path):
    from project_mcp.server import Runtime, create_admin_app
    s = settings(tmp_path)
    with TestClient(create_admin_app(Runtime(s)), base_url="http://127.0.0.1:8766") as c:
        assert c.get("/api/status").status_code == 401
        headers = {"Authorization": "Bearer " + s.admin_token}
        r = c.get("/api/status", headers=headers)
        assert r.status_code == 200
        assert r.json()["projects"][0]["id"] == "demo"
        assert r.json()["projects"][0]["root"] == str(tmp_path)
        assert s.admin_token not in r.text
        assert s.mcp_token not in r.text
        assert c.get("/api/status", headers={**headers, "Origin":"https://evil.test"}).status_code == 403
        assert c.get("/api/status", headers={**headers, "Host":"evil.test"}).status_code == 403


def test_context_reachable_by_explicit_session_only_and_clearable(tmp_path):
    from project_mcp.server import Runtime, create_admin_app
    s = settings(tmp_path)
    runtime = Runtime(s)
    with TestClient(create_admin_app(runtime), base_url="http://127.0.0.1:8766",
                    headers={"Authorization": "Bearer " + s.admin_token}) as c:
        body = {"project_id":"demo", "session_id":"window-a", "path":"main.py", "version":1,
                "text":"edited", "diagnostics":[]}
        assert c.put("/api/context", json=body).status_code == 200
        assert runtime.contexts.get("demo", "window-a")["text"] == "edited"
        assert c.put("/api/context", json={**body, "path":"../outside"}).status_code in (400,403)
        assert c.delete("/api/context/window-a").status_code == 200
        assert runtime.contexts.list() == []


def test_admin_project_registration_persists_and_disables_removed_context(tmp_path):
    from project_mcp.server import Runtime, create_admin_app
    s = settings(tmp_path)
    config_path = tmp_path / "config.json"
    runtime = Runtime(s, config_path)
    with TestClient(create_admin_app(runtime), base_url="http://127.0.0.1:8766",
                    headers={"Authorization": "Bearer " + s.admin_token}) as c:
        assert c.put("/api/projects", json={"id":"second", "root":str(tmp_path)}).status_code == 200
        assert len(json.loads(config_path.read_text())["projects"]) == 2
        assert c.delete("/api/projects/second").status_code == 200
        assert [p["id"] for p in c.get("/api/status").json()["projects"]] == ["demo"]


@pytest.mark.asyncio
async def test_mcp_http_rejects_anonymous_and_has_no_management_route(tmp_path):
    from project_mcp.server import Runtime, create_mcp
    s = settings(tmp_path)
    mcp = create_mcp(Runtime(s))
    app = mcp.http_app(path="/mcp", stateless_http=True)
    async with app.lifespan(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost"
    ) as c:
        assert (await c.post("/mcp", json={})).status_code == 401
        assert (await c.get("/api/status")).status_code == 404


@pytest.mark.asyncio
async def test_real_mcp_client_tools_read_saved_and_editor_sources(tmp_path):
    from fastmcp import Client

    from project_mcp.server import Runtime, create_mcp
    s = settings(tmp_path)
    runtime = Runtime(s)
    runtime.contexts.put(runtime.workspace("demo"), {
        "project_id":"demo", "session_id":"one", "path":"main.py", "version":1, "text":"unsaved"
    })
    async with Client(create_mcp(runtime)) as client:
        names = {t.name for t in await client.list_tools()}
        assert {"read_file", "search_code", "git_diff", "get_editor_context"} <= names
        r = await client.call_tool("read_file", {"project_id":"demo", "path":"main.py"})
        assert "saved" in str(r.data)
        r = await client.call_tool("get_editor_context", {"project_id":"demo", "session_id":"one"})
        assert r.data["text"] == "unsaved"
        assert r.data["source"] == "editor_buffer"
        r = await client.call_tool("read_file", {"project_id":"absent", "path":"main.py"}, raise_on_error=False)
        assert r.is_error


@pytest.mark.asyncio
async def test_github_authorization_rejects_valid_but_non_owner_token(monkeypatch):
    from fastmcp.server.auth import AccessToken
    from fastmcp.server.auth.providers.github import GitHubProvider

    from project_mcp.auth import OwnerGitHubProvider
    from project_mcp.health import HealthRegistry
    async def upstream(self, token):
        return AccessToken(token=token, client_id="test", scopes=[], claims={"sub":token})
    monkeypatch.setattr(GitHubProvider, "load_access_token", upstream)
    health = HealthRegistry()
    health.record("local_service", "ok")
    provider = OwnerGitHubProvider(owner_ids=["123"], health=health,
                                   client_id="test", client_secret="x" * 40,
                                   base_url="https://mcp.example.com")
    assert await provider.load_access_token("456") is None
    assert health.snapshot()["oauth"]["state"] == "failed"
    assert health.snapshot()["local_service"]["state"] == "ok"
    assert (await provider.load_access_token("123")).claims["sub"] == "123"
    assert health.snapshot()["oauth"]["state"] == "ok"
