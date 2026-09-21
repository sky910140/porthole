import asyncio
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import httpx


def invoke(*args):
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
    return subprocess.run([sys.executable, "-m", "project_mcp.cli", *map(str,args)],
                          capture_output=True, text=True, timeout=35, env=env, check=False)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_init_preserves_existing_config_and_doctor(tmp_path):
    config = tmp_path / "local.json"
    r = invoke("init", "--config", config, "--project", tmp_path, "--id", "demo")
    assert r.returncode == 0, r.stderr
    before = config.read_bytes()
    assert invoke("init", "--config", config, "--project", tmp_path).returncode != 0
    assert config.read_bytes() == before
    result = invoke("doctor", "--config", config)
    assert result.returncode == 0, result.stderr
    assert "local" in result.stdout


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
