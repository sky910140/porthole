import json

import pytest


def test_config_requires_explicit_project_and_independent_tokens(tmp_path):
    from project_mcp.config import load_config
    f = tmp_path / "config.json"
    f.write_text(json.dumps({"projects": [{"id": "demo", "root": str(tmp_path)}]}))
    config = load_config(f)
    assert config.projects[0].id == "demo"
    assert len(config.admin_token) >= 32
    assert config.admin_token != config.mcp_token
    assert load_config(f).admin_token == config.admin_token


def test_public_mode_fails_closed_without_oauth(tmp_path):
    from project_mcp.config import Settings
    with pytest.raises(ValueError):
        Settings(projects=[], public_url="https://mcp.example.com", auth_mode="local")


def test_context_versions_isolation_and_expiry(tmp_path):
    from project_mcp.context import ContextStore
    from project_mcp.policy import ProjectPolicy
    from project_mcp.workspace import Workspace
    (tmp_path / "main.py").write_text("saved", encoding="utf8")
    store = ContextStore(ttl=0.05)
    workspace = Workspace(
        tmp_path, "demo", policy=ProjectPolicy(share_editor_buffers=True)
    )
    payload = {"project_id": "demo", "session_id": "editor-one", "path": "main.py", "version": 2,
                   "text": "unsaved", "selection": None, "diagnostics": []}
    store.put(workspace, payload)
    assert store.get("demo", "editor-one")["text"] == "unsaved"
    with pytest.raises(ValueError):
        store.get("other", "editor-one")
    with pytest.raises(ValueError):
        store.put(workspace, {**payload, "version": 1})
    assert (tmp_path / "main.py").read_text() == "saved"
    import time
    time.sleep(0.06)
    with pytest.raises(ValueError):
        store.get("demo", "editor-one")


def test_context_rejects_secrets_and_oversize(tmp_path):
    from project_mcp.context import ContextStore
    from project_mcp.policy import ProjectPolicy
    from project_mcp.workspace import Workspace
    (tmp_path / ".env").write_text("SECRET=abc")
    (tmp_path / "main.py").write_text("ok")
    store = ContextStore()
    workspace = Workspace(
        tmp_path, "demo", policy=ProjectPolicy(share_editor_buffers=True)
    )
    payload = {"project_id": "demo", "session_id": "editor-one", "path": ".env", "version": 1,
                   "text": "SECRET=abc", "diagnostics": []}
    with pytest.raises((ValueError, PermissionError)):
        store.put(workspace, payload)
    with pytest.raises(ValueError):
        store.put(workspace, {**payload, "path": "main.py", "text": "x" * 1_048_577})


def test_duplicate_projects_and_insecure_urls_rejected(tmp_path):
    from project_mcp.config import Settings
    with pytest.raises(ValueError):
        Settings(projects=[{"id":"a", "root":tmp_path}, {"id":"a", "root":tmp_path}])
    with pytest.raises(ValueError):
        Settings(projects=[], auth_mode="github", public_url="http://example.com")
