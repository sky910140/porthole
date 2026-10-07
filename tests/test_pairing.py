from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from starlette.testclient import TestClient

from project_mcp.config import Settings


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


def test_default_config_uses_user_app_data(monkeypatch, tmp_path):
    from project_mcp.config import default_config_path

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    monkeypatch.chdir(tmp_path)
    result = default_config_path()
    assert result == (tmp_path / "LocalAppData" / "Porthole" / "config.json").resolve()
    assert result.parent.name == "Porthole"


def test_pairing_code_is_hashed_single_use_and_expires(tmp_path):
    from project_mcp.pairing import PairingStore

    clock = Clock()
    store = PairingStore(tmp_path, now=clock, ttl_seconds=10)
    issued = store.issue()
    state_text = (tmp_path / "pairing.json").read_text(encoding="utf8")
    assert issued["pairing_code"] not in state_text
    assert store.consume(issued["pairing_code"])
    assert not store.consume(issued["pairing_code"])

    expired = store.issue()
    clock.value += timedelta(seconds=11)
    assert not store.consume(expired["pairing_code"])
    assert not (tmp_path / "pairing.json").exists()


def test_unauthenticated_pairing_requires_fresh_local_code(tmp_path):
    from project_mcp.server import Runtime, create_admin_app

    (tmp_path / "main.py").write_text("print('ok')\n", encoding="utf8")
    settings = Settings(
        projects=[{"id": "demo", "root": tmp_path}],
        admin_token="a" * 40,
        mcp_token="m" * 40,
        state_dir=tmp_path / "state",
    )
    runtime = Runtime(settings)
    issued = runtime.pairing.issue()
    with TestClient(create_admin_app(runtime), base_url="http://127.0.0.1:8766") as client:
        response = client.post("/api/pair", json={"pairing_code": issued["pairing_code"]})
        assert response.status_code == 200
        payload = response.json()
        assert payload["admin_token"] == settings.admin_token
        assert payload["protocol_version"].startswith("1.")
        assert client.post(
            "/api/pair", json={"pairing_code": issued["pairing_code"]}
        ).status_code == 401
        assert client.post("/api/pair", json={"pairing_code": "wrong"}).status_code == 401


def test_pair_command_prints_short_lived_code_not_long_term_secret(tmp_path, capsys):
    from project_mcp.cli import main
    from project_mcp.config import load_config, save_config

    config = tmp_path / "config.json"
    save_config(config, Settings(projects=[{"id": "demo", "root": tmp_path}]))
    settings = load_config(config)
    assert main(["pair", "--config", str(config)]) == 0
    output = capsys.readouterr().out
    payload = json.loads(output)
    assert payload["pairing_code"]
    assert settings.admin_token not in output
    assert settings.mcp_token not in output
    assert payload["pairing_code"] not in (
        settings.state_dir / "pairing.json"
    ).read_text(encoding="utf8")
