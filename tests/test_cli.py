import asyncio
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import httpx


def test_credential_store_reads_stdin_without_echo_or_arguments(tmp_path, monkeypatch, capsys):
    import io

    from project_mcp import cli
    from project_mcp.config import Settings, save_config

    config = tmp_path / "config.json"
    save_config(config, Settings())
    received = []
    monkeypatch.setattr("project_mcp.auth.store_github_credentials", lambda state, client, secret:
                        received.append((state, client, secret)))
    monkeypatch.setattr("sys.stdin", io.StringIO('{"client_id":"id","client_secret":"private"}'))
    assert cli.main(["credential-store", "--config", str(config)]) == 0
    assert received[0][1:] == ("id", "private")
    assert "private" not in capsys.readouterr().out


def test_upgrade_marker_blocks_start_until_offline_checks_pass(tmp_path):
    from project_mcp.cli import _upgrade_blocks_start

    state = tmp_path / "state"
    state.mkdir()
    marker = state / "upgrade-in-progress.json"
    assert _upgrade_blocks_start(state) is False
    marker.write_text('{"snapshot_id":"abc"}')
    assert _upgrade_blocks_start(state) is True
    marker.write_text('{"snapshot_id":"abc","phase":"awaiting_verification"}')
    assert _upgrade_blocks_start(state) is False


def invoke(*args):
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
    return subprocess.run([sys.executable, "-m", "project_mcp.cli", *map(str,args)],
                          capture_output=True, text=True, timeout=35, env=env, check=False)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_server_command_supports_python_and_frozen_runtime(tmp_path):
    from project_mcp.cli import server_command

    config = tmp_path / "config.json"
    assert server_command(config, executable="python.exe", frozen=False) == [
        "python.exe", "-m", "project_mcp.cli", "serve", "--config", str(config)
    ]
    assert server_command(config, executable="porthole.exe", frozen=True) == [
        "porthole.exe", "serve", "--config", str(config)
    ]


def test_upgrade_snapshot_id_is_validated_before_reading_paths(tmp_path):
    result = invoke(
        "upgrade-restore", "--config", tmp_path / "config.json",
        "--runtime-dir", tmp_path / "runtime" / "current",
        "--snapshot-id", "../outside",
    )
    assert result.returncode == 2
    assert "invalid snapshot id" in result.stderr


def test_init_preserves_existing_config_and_doctor(tmp_path):
    config = tmp_path / "local.json"
    r = invoke("init", "--config", config, "--project", tmp_path, "--id", "demo")
    assert r.returncode == 0, r.stderr
    before = config.read_bytes()
    assert invoke("init", "--config", config, "--project", tmp_path).returncode != 0
    assert config.read_bytes() == before
    result = invoke("doctor", "--config", config)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["mode"] == "local"
    assert set(report["health"]) == {"local_service", "transport", "oauth", "tool_call"}
    assert report["health"]["local_service"]["state"] == "failed"
    assert report["fixes"]["tool_call"].startswith("Create a verification challenge")
    tokens = json.loads((tmp_path / ".local" / "tokens.json").read_text())
    assert all(secret not in result.stdout for secret in tokens.values())


def test_start_http_mcp_status_and_stop_only_owned_server(tmp_path):
    config = tmp_path / "local.json"
    assert invoke("init", "--config", config, "--project", tmp_path, "--id", "demo").returncode == 0
    value = json.loads(config.read_text())
    value.update(mcp_port=free_port(), admin_port=free_port())
    config.write_text(json.dumps(value))
    r = invoke("start", "--config", config)
    try:
        assert r.returncode == 0, (r.stdout, r.stderr)
        assert invoke("status", "--config", config).returncode == 0
        again = invoke("start", "--config", config)
        assert again.returncode == 0
        token = json.loads((tmp_path / ".local" / "tokens.json").read_text())["mcp_token"]
        r = httpx.post(f'http://127.0.0.1:{value["mcp_port"]}/mcp',
            headers={"Authorization":f"Bearer {token}", "Accept":"application/json, text/event-stream"},
            json={"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
                "protocolVersion":"2025-03-26", "capabilities":{},
                "clientInfo":{"name":"self-test","version":"1"}}})
        assert r.status_code == 200, r.text
        assert "serverInfo" in r.text
        async def client_reads_over_http():
            from fastmcp import Client
            async with Client(f'http://127.0.0.1:{value["mcp_port"]}/mcp', auth=token) as client:
                projects = await client.call_tool("list_projects", {})
                assert projects.data[0]["id"] == "demo"
                assert "root" not in projects.data[0]
                result = await client.call_tool("list_files", {"project_id":"demo"})
                assert "files" in result.data
        asyncio.run(client_reads_over_http())
    finally:
        stopped = invoke("stop", "--config", config)
        assert stopped.returncode == 0, stopped.stderr
    assert invoke("status", "--config", config).returncode != 0


def test_concurrent_start_reuses_single_managed_instance(tmp_path):
    config = tmp_path / "local.json"
    assert invoke("init", "--config", config, "--project", tmp_path, "--id", "demo").returncode == 0
    value = json.loads(config.read_text())
    value.update(mcp_port=free_port(), admin_port=free_port())
    config.write_text(json.dumps(value))
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
    command = [sys.executable, "-m", "project_mcp.cli", "start", "--config", str(config)]
    first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    second = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    try:
        first_out, first_err = first.communicate(timeout=35)
        second_out, second_err = second.communicate(timeout=35)
        assert first.returncode == 0, first_err or first_out
        assert second.returncode == 0, second_err or second_out
        assert invoke("status", "--config", config).returncode == 0
    finally:
        invoke("stop", "--config", config)
