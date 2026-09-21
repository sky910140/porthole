import pytest
from fastmcp import Client

from project_mcp.config import Settings
from project_mcp.server import Runtime, create_mcp


@pytest.mark.asyncio
async def test_actual_state_and_config_paths_are_never_shared(tmp_path):
    state = tmp_path / "runtime"
    state.mkdir()
    (state / "plain.txt").write_text("NEVER-SHARE")
    cfg = tmp_path / "custom.json"
    cfg.write_text("NEVER-SHARE")
    settings = Settings(projects=[{"id":"demo", "root":tmp_path}], state_dir=state,
                        admin_token="a"*40, mcp_token="m"*40)
    runtime = Runtime(settings, cfg)
    async with Client(create_mcp(runtime)) as client:
        for file in ("runtime/plain.txt", "custom.json"):
            result = await client.call_tool("read_file", {"project_id":"demo", "path":file}, raise_on_error=False)
            assert result.is_error
        result = await client.call_tool("search_code", {"project_id":"demo", "query":"NEVER-SHARE"})
        assert result.data["matches"] == []


def test_oauth_missing_credentials_fails_closed(tmp_path, monkeypatch):
    from project_mcp.auth import build_auth
    monkeypatch.delenv("PROJECT_MCP_GITHUB_CLIENT_ID", raising=False)
    monkeypatch.delenv("PROJECT_MCP_GITHUB_CLIENT_SECRET", raising=False)
    settings = Settings(auth_mode="github", public_url="https://mcp.example.com", github_user_ids=["123"], state_dir=tmp_path)
    with pytest.raises(ValueError, match="PROJECT_MCP_GITHUB"):
        build_auth(settings)


@pytest.mark.asyncio
async def test_oauth_discovery_uses_configured_https_origin(tmp_path, monkeypatch):
    import httpx
    monkeypatch.setenv("PROJECT_MCP_GITHUB_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("PROJECT_MCP_GITHUB_CLIENT_SECRET", "test-secret" * 8)
    settings = Settings(auth_mode="github", public_url="https://mcp.example.com", github_user_ids=["123"], state_dir=tmp_path)
    app = create_mcp(Runtime(settings)).http_app(path="/mcp")
    async with app.lifespan(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://mcp.example.com") as c:
        r = await c.get("/.well-known/oauth-authorization-server")
        assert r.status_code == 200
        assert r.json()["issuer"] == "https://mcp.example.com/"
        assert (await c.post("/mcp", json={})).status_code == 401


@pytest.mark.asyncio
async def test_authorize_with_url_client_id_reaches_consent(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    import httpx
    from fastmcp import FastMCP
    from fastmcp.server.auth.oauth_proxy.models import ProxyDCRClient

    from project_mcp.auth import build_auth

    monkeypatch.setenv("PROJECT_MCP_GITHUB_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("PROJECT_MCP_GITHUB_CLIENT_SECRET", "test-secret" * 8)
    settings = Settings(auth_mode="github", public_url="https://mcp.example.com",
                        github_user_ids=["123"], state_dir=tmp_path)
    auth = build_auth(settings)
    client_id = "https://chatgpt.com/oauth/regression/client.json"
    redirect_uri = "https://chatgpt.com/oauth/callback"
    client = ProxyDCRClient(client_id=client_id, client_name="Regression client",
                            redirect_uris=[redirect_uri], scope="read:user",
                            token_endpoint_auth_method="none")
    # Only the remote metadata fetch is mocked; the Windows store and HTTP route are real.
    monkeypatch.setattr(auth._cimd_manager, "get_client", AsyncMock(return_value=client))
    app = FastMCP("OAuth regression", auth=auth).http_app(path="/mcp")
    async with app.lifespan(app), httpx.AsyncClient(transport=httpx.ASGITransport(app),
                                                  base_url="https://mcp.example.com") as c:
        response = await c.get("/authorize", params={
            "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "scope": "read:user", "state": "regression", "code_challenge": "a" * 43,
            "code_challenge_method": "S256",
        })
        assert response.status_code == 302
        consent = await c.get(response.headers["location"])
        assert consent.status_code == 200
        assert "Regression client" in consent.text
        assert await auth._client_store.get(key=client_id) is not None
