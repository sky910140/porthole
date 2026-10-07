"""Exercise cross-directory OAuth migration with the actual bundled service."""

import argparse
import asyncio
import json
import os
import socket
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from project_mcp.auth import encrypted_store
from project_mcp.config import load_config


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def discovery_status(port):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/.well-known/oauth-authorization-server")
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status


async def verify(executable: Path):
    secret = "isolated-test-github-secret"
    with tempfile.TemporaryDirectory(prefix="porthole-web-migrate-") as temporary:
        root = Path(temporary)
        old_state, new_state = root / "old-state", root / "new-state"
        old_state.mkdir()
        new_state.mkdir()
        old_config, new_config = root / "old.json", root / "new.json"
        old_config.write_text(json.dumps({"auth_mode": "github", "public_url": "https://example.test",
            "github_user_ids": ["123"], "state_dir": str(old_state)}), encoding="utf8")
        mcp_port, admin_port = free_port(), free_port()
        while admin_port == mcp_port:
            admin_port = free_port()
        new_config.write_text(json.dumps({"config_version": "0.3", "projects": [], "auth_mode": "local",
            "state_dir": str(new_state), "mcp_port": mcp_port, "admin_port": admin_port}), encoding="utf8")
        load_config(new_config)
        original_tokens = (new_state / "tokens.json").read_bytes()
        store = encrypted_store(old_state / "oauth", secret)
        await store.put("client", {"client_id": "preserved-client"}, collection="mcp-oauth-proxy-clients")
        script = """
const {prepareMigration,executeMigration,managedStatus}=require(process.argv[1]);
const {execFileSync}=require('node:child_process');
(async()=>{
  const p=prepareMigration(process.argv[2],process.argv[3],process.env.TEST_GITHUB_SECRET);
  await executeMigration(p,{stop:async()=>{},start:async()=>{
    execFileSync(process.argv[4],['start','--config',process.argv[3]],{env:{...process.env,
      PROJECT_MCP_GITHUB_CLIENT_ID:'isolated-test-client-id',
      PROJECT_MCP_GITHUB_CLIENT_SECRET:process.env.TEST_GITHUB_SECRET}});
    if(!await managedStatus(process.argv[3]))throw new Error('managed identity mismatch');
  },restore:async()=>{}});
})().catch(e=>{console.error(e.message);process.exitCode=1});
"""
        environment = {**os.environ, "TEST_GITHUB_SECRET": secret}
        migration_module = Path(__file__).resolve().parents[1] / "extensions/vscode/lib/web-migration.js"
        try:
            try:
                await asyncio.to_thread(subprocess.run, ["node", "-e", script, str(migration_module), str(old_config),
                    str(new_config), str(executable)], env=environment, check=True, timeout=45,
                    capture_output=True, text=True)
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stdout + error.stderr) from error
            migrated = encrypted_store(new_state / "oauth", secret)
            assert await migrated.get("client", collection="mcp-oauth-proxy-clients") == {
                "client_id": "preserved-client"}
            assert (new_state / "tokens.json").read_bytes() == original_tokens
            assert (old_state / "oauth").is_dir()
            assert await asyncio.to_thread(discovery_status, mcp_port) == 200
            print("OAuth migration interoperability: passed")
        finally:
            await asyncio.to_thread(subprocess.run, [str(executable), "stop", "--config", str(new_config)],
                capture_output=True, check=False, timeout=15)
            # The CLI acknowledges shutdown before Windows releases the child log handle.
            await asyncio.sleep(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    asyncio.run(verify(parser.parse_args().executable.resolve()))
