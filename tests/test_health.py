from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from project_mcp.config import Settings


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 9, 21, 10, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


def test_local_health_does_not_claim_remote_success():
    from project_mcp.health import HealthRegistry

    health = HealthRegistry()
    health.record("local_service", "ok")
    result = health.snapshot()
    assert result["local_service"]["state"] == "ok"
    assert result["transport"]["state"] == "unknown"
    assert result["oauth"]["state"] == "unknown"
    assert result["tool_call"]["state"] == "unknown"


def test_layer_failure_is_independent_and_stale_results_expire():
    from project_mcp.health import HealthRegistry

    clock = Clock()
    health = HealthRegistry(ttl_seconds=30, now=clock)
    health.record("local_service", "ok")
    health.record("oauth", "failed", error_code="AUTH_REQUIRED", retryable=True)
    assert health.snapshot()["local_service"]["state"] == "ok"
    clock.value += timedelta(seconds=31)
    snapshot = health.snapshot()
    assert snapshot["local_service"]["state"] == "expired"
    assert snapshot["oauth"]["state"] == "expired"


def test_only_matching_unexpired_challenge_can_record_tool_success(tmp_path):
    from project_mcp.health import HealthRegistry

    clock = Clock()
    health = HealthRegistry(challenge_ttl_seconds=10, now=clock)
    challenge = health.create_challenge("demo", expected_tool="verify_connection")
    assert not health.complete_challenge(
        challenge["challenge_id"], "other", "verify_connection", read_succeeded=True
    )
    assert health.snapshot()["tool_call"]["state"] == "checking"
    assert health.complete_challenge(
        challenge["challenge_id"], "demo", "verify_connection", read_succeeded=True
    )
    assert health.snapshot()["tool_call"]["state"] == "ok"

    expired = health.create_challenge("demo", expected_tool="verify_connection")
    clock.value += timedelta(seconds=11)
    assert not health.complete_challenge(
        expired["challenge_id"], "demo", "verify_connection", read_succeeded=True
    )
    result = health.snapshot()["tool_call"]
    assert result["state"] == "expired"
    assert result["error_code"] == "LEASE_EXPIRED"


def test_status_exposes_version_capabilities_and_layered_health(tmp_path):
    from project_mcp.server import Runtime, create_admin_app

    (tmp_path / "main.py").write_text("print('ok')\n", encoding="utf8")
    settings = Settings(
        projects=[{"id": "demo", "root": tmp_path}],
        admin_token="a" * 40,
        mcp_token="m" * 40,
        state_dir=tmp_path / ".local",
    )
    runtime = Runtime(settings)
    with TestClient(
        create_admin_app(runtime),
        base_url="http://127.0.0.1:8766",
        headers={"Authorization": "Bearer " + settings.admin_token},
    ) as client:
        response = client.get("/api/status")
        assert response.status_code == 200
        status = response.json()
        assert status["protocol_version"].split(".")[0] == "1"
        from project_mcp import __version__
        assert status["service_version"] == __version__
        assert "layered_health" in status["capabilities"]
        assert status["health"]["local_service"]["state"] == "ok"
        assert status["health"]["tool_call"]["state"] == "unknown"
        assert status["cloud_account_verified"] is False

        challenge = client.post("/api/verification-challenges", json={"project_id": "demo"})
        assert challenge.status_code == 200
        assert challenge.json()["expected_tool"] == "verify_connection"


@pytest.mark.asyncio
async def test_ordinary_read_cannot_complete_verification_challenge(tmp_path):
    from fastmcp import Client

    from project_mcp.server import Runtime, create_mcp

    (tmp_path / "main.py").write_text("print('ok')\n", encoding="utf8")
    runtime = Runtime(Settings(
        projects=[{"id": "demo", "root": tmp_path}],
        admin_token="a" * 40,
        mcp_token="m" * 40,
        state_dir=tmp_path / ".local",
    ))
    challenge = runtime.health.create_challenge("demo")
    async with Client(create_mcp(runtime)) as client:
        await client.call_tool("read_file", {"project_id": "demo", "path": "main.py"})
        assert runtime.health.snapshot()["tool_call"]["state"] == "checking"
        wrong = await client.call_tool(
            "verify_connection",
            {"project_id": "demo", "challenge_id": "wrong"},
            raise_on_error=False,
        )
        assert wrong.is_error
        assert runtime.health.snapshot()["tool_call"]["state"] == "checking"
        result = await client.call_tool(
            "verify_connection",
            {"project_id": "demo", "challenge_id": challenge["challenge_id"]},
        )
        assert result.data["verified"] is True
        assert runtime.health.snapshot()["tool_call"]["state"] == "ok"
