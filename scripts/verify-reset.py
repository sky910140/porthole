"""Verify the frozen reset command without touching the user's real installation."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

import httpx
from fastmcp import Client
from verify_runtime import free_port, invoke, temporary_runtime_root


async def verify(executable: Path) -> None:
    with temporary_runtime_root() as root:
        project = root / "project"
        project.mkdir()
        source = project / "README.md"
        source.write_text("# Project survives reset\n", encoding="utf8")
        config = root / "config.json"

        def command(name, *args):
            value = invoke(executable, name, "--config", str(config), *args, timeout=60)
            assert value.returncode == 0, value.stderr or value.stdout
            return value.stdout

        command("init", "--project", str(project), "--id", "demo")
        settings = json.loads(config.read_text(encoding="utf8"))
        settings.update(mcp_port=free_port(), admin_port=free_port())
        config.write_text(json.dumps(settings), encoding="utf8")
        command("start")
        try:
            state = root / ".local"
            tokens = json.loads((state / "tokens.json").read_text(encoding="utf8"))
            protected = state / "changes" / "content" / "reset-fixture.blob"
            protected.parent.mkdir(parents=True, exist_ok=True)
            protected.write_bytes(b"encrypted recovery contents remain")
            business = state / "business-data.bin"
            business.write_bytes(b"unrelated state must remain")
            retained = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, protected, business)}
            mcp_url = f"http://127.0.0.1:{settings['mcp_port']}/mcp"
            admin_url = f"http://127.0.0.1:{settings['admin_port']}/api/status"
            async with Client(mcp_url, auth=tokens["mcp_token"]) as client:
                tools = await client.list_tools()
                assert not any("reset" in tool.name for tool in tools)
                assert (await client.call_tool("read_file", {"project_id": "demo", "path": "README.md"})).data
            command("pair")
            oauth = state / "oauth"
            oauth.mkdir(exist_ok=True)
            (oauth / "revoked-fixture.json").write_text("expired authorization fixture")
            (state / "verification-history.json").write_text("{}")
            checked = json.loads(command("reset-check"))
            assert checked["ready"] is True
            first = json.loads(command("reset-local"))
            assert first["local_reset"] is True
            assert not (config.parent / ".reset-in-progress.json").exists()
            assert all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in retained.items())
            assert not any((state / name).exists() for name in ("oauth", "pairing.json", "verification-history.json"))
            for secret in tokens.values():
                assert secret not in json.dumps(first)
            second = json.loads(command("reset-local"))
            assert second == first
            command("start")
            async with httpx.AsyncClient(trust_env=False) as http:
                rejected = await http.get(admin_url, headers={"Authorization": "Bearer " + tokens["admin_token"]})
                assert rejected.status_code == 401
            new_tokens = json.loads((state / "tokens.json").read_text(encoding="utf8"))
            async with Client(mcp_url, auth=new_tokens["mcp_token"]) as client:
                assert (await client.call_tool("list_projects", {})).data == []
            async with httpx.AsyncClient(trust_env=False) as http:
                rejected = await http.post(mcp_url, headers={"Authorization": "Bearer " + tokens["mcp_token"]},
                                          json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                assert rejected.status_code == 401
            command("stop")
            print("Frozen reset: live shutdown, empty grants after restart, old admin/MCP token rejection, idempotence, no remote reset tool and unchanged source/recovery files passed")
        finally:
            command("stop")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    asyncio.run(verify(parser.parse_args().executable.resolve()))
