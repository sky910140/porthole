"""Local lifecycle commands. Shutdown uses authenticated IPC, never arbitrary PID killing."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import Settings, load_config, save_config


def status(settings, path):
    try:
        response = httpx.get(f"http://127.0.0.1:{settings.admin_port}/api/status",
            headers={"Authorization": "Bearer " + settings.admin_token}, timeout=1, trust_env=False)
        if response.status_code == 200:
            result = response.json()
            expected = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
            if result.get("config_id") == expected:
                return result
    except (httpx.HTTPError, ValueError):
        pass
    return None


async def serve(settings, path):
    import uvicorn

    from .server import Runtime, create_admin_app, create_mcp
    runtime = Runtime(settings, path)
    hosts = [f"localhost:{settings.mcp_port}", f"127.0.0.1:{settings.mcp_port}"]
    if settings.public_url:
        hosts.append(urlsplit(settings.public_url).netloc)
    mcp_app = create_mcp(runtime).http_app(path="/mcp", stateless_http=True,
        json_response=True, allowed_hosts=hosts, allowed_origins=[])
    apps = [(mcp_app, settings.mcp_port), (create_admin_app(runtime), settings.admin_port)]
    sockets, servers, tasks = [], [], []
    try:
        # Reserve both ports before starting either app; collisions never stop another process.
        for app, port in apps:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            sock.bind(("127.0.0.1", port))
            sock.listen(128)
            server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False,
                proxy_headers=False, timeout_graceful_shutdown=3))
            servers.append(server)
            tasks.append(asyncio.create_task(server.serve(sockets=[sock])))
        stop_task = asyncio.create_task(runtime.stop_requested.wait())
        done, _ = await asyncio.wait([*tasks, stop_task], return_when=asyncio.FIRST_COMPLETED)
        stop_task.cancel()
        for task in done:
            if task in tasks:
                task.result()
    finally:
        for server in servers:
            server.should_exit = True
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for sock in sockets:
            sock.close()


def start(settings, path):
    if status(settings, path):
        print("Already running")
        return
    lock_path = settings.state_dir / "starting.lock"
    try:
        lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError("Startup already in progress; inspect .local/starting.lock if interrupted") from None
    os.close(lock_fd)
    try:
        with (settings.state_dir / "server.log").open("ab") as log:
            process = subprocess.Popen([sys.executable, "-m", "project_mcp.cli", "serve", "--config", str(path)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                start_new_session=os.name != "nt")
        for _ in range(100):
            if status(settings, path):
                print(f"Running. Management: http://127.0.0.1:{settings.admin_port}")
                return
            if process.poll() is not None:
                raise ValueError("Startup failed; inspect the local server.log (ports or OAuth settings)")
            time.sleep(0.1)
        process.terminate()  # Exact Popen child of this invocation, never an unrelated PID.
        process.wait(timeout=5)
        raise ValueError("Startup timed out")
    finally:
        lock_path.unlink(missing_ok=True)


def stop(settings, path):
    if not status(settings, path):
        print("Not running for this configuration")
        return
    response = httpx.post(f"http://127.0.0.1:{settings.admin_port}/api/shutdown",
        headers={"Authorization": "Bearer " + settings.admin_token}, timeout=3, trust_env=False)
    response.raise_for_status()
    for _ in range(40):
        if not status(settings, path):
            print("Stopped")
            return
        time.sleep(0.2)
    raise ValueError("Shutdown timed out; no unrelated process was terminated")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local Project Assistant")
    parser.add_argument("command", choices=["init", "serve", "start", "stop", "status", "doctor", "token"])
    parser.add_argument("--config", type=Path, default=Path("config/local.json"))
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--id", default="current")
    parser.add_argument("--kind", choices=["admin", "mcp"], default="admin")
    args = parser.parse_args(argv)
    path = args.config.resolve()
    try:
        if args.command == "init":
            if path.exists():
                raise ValueError("Configuration already exists; refusing to overwrite")
            settings = Settings(projects=[{"id": args.id, "root": args.project.resolve()}])
            path.parent.mkdir(parents=True, exist_ok=True)
            save_config(path, settings)
            load_config(path)
            print(f"Initialized: {path}")
            return 0
        settings = load_config(path)
        if args.command == "serve":
            asyncio.run(serve(settings, path))
        elif args.command == "start":
            start(settings, path)
        elif args.command == "stop":
            stop(settings, path)
        elif args.command == "status":
            result = status(settings, path)
            print(json.dumps(result or {"status": "stopped"}, ensure_ascii=True, indent=2))
            return 0 if result else 1
        elif args.command == "doctor":
            from .auth import build_auth
            from .health import HealthRegistry
            build_auth(settings)
            live = status(settings, path)
            if live:
                health = live.get("health", HealthRegistry().snapshot())
            else:
                registry = HealthRegistry()
                registry.record("local_service", "failed", "STORAGE_UNAVAILABLE", retryable=True)
                health = registry.snapshot()
            fixes = {
                "local_service": "Run project-assistant start and inspect the local log if it fails.",
                "transport": "Check the HTTPS endpoint or tunnel, then retry verification.",
                "oauth": "Reconnect the MCP integration with the authorized account.",
                "tool_call": "Create a verification challenge and call verify_connection from the AI client.",
            }
            print(json.dumps({
                "mode": settings.auth_mode,
                "projects": [p.id for p in settings.projects],
                "git_available": bool(shutil.which("git")),
                "cloudflared_available": bool(shutil.which("cloudflared")),
                "running": bool(live),
                "health": health,
                "fixes": {layer: fixes[layer] for layer, check in health.items()
                          if check["state"] != "ok"},
            }, indent=2))
        elif args.command == "token":
            # Only this explicit user-facing command prints credentials; never include in status/logs.
            print(settings.admin_token if args.kind == "admin" else settings.mcp_token)
        return 0
    except (ValueError, OSError, httpx.HTTPError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
