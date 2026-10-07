"""Local lifecycle commands. Shutdown uses authenticated IPC, never arbitrary PID killing."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .changes.content import StorageUnavailable
from .config import Settings, default_config_path, load_config, save_config
from .reset import (
    RESET_PROFILE_LOCK_TIMEOUT,
    LocalReset,
    ResetError,
    lifecycle_lock,
    profile_edit_lock,
    reject_links,
    require_no_pending_reset,
    reset_generation,
    reset_lock,
)
from .upgrade import UpgradeError


def _upgrade_blocks_start(state_dir: Path) -> bool:
    marker = state_dir / "upgrade-in-progress.json"
    if not marker.exists():
        return False
    try:
        return json.loads(marker.read_text(encoding="utf-8")).get("phase") != "awaiting_verification"
    except (OSError, ValueError):
        return True


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


def server_command(path: Path, *, executable: str | None = None, frozen: bool | None = None):
    executable = executable or sys.executable
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    prefix = [executable] if frozen else [executable, "-m", "project_mcp.cli"]
    return [*prefix, "serve", "--config", str(path)]


async def serve(settings, path):
    with lifecycle_lock(path):
        require_no_pending_reset(path)
        # A reset may have completed while this process waited for the lifecycle lock.
        await _serve(_fresh_start_settings(settings, path), path)


def _fresh_start_settings(settings, path):
    current = load_config(path)
    if (current.admin_token != settings.admin_token or current.mcp_token != settings.mcp_token):
        raise ResetError("RESET_PENDING", "Reset invalidated this startup request; start again explicitly")
    return current


async def _serve(settings, path):
    import uvicorn

    from .server import Runtime, create_admin_app, create_mcp
    if _upgrade_blocks_start(settings.state_dir or path.parent / ".local"):
        raise ValueError("Upgrade in progress; complete or restore the snapshot before starting")
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
    with reset_lock(path):
        require_no_pending_reset(path)
        return _start(_fresh_start_settings(settings, path), path)


def _start(settings, path):
    require_no_pending_reset(path)
    if _upgrade_blocks_start(settings.state_dir or path.parent / ".local"):
        raise ValueError("Upgrade in progress; complete or restore the snapshot before starting")
    if status(settings, path):
        print("Already running")
        return
    lock_path = settings.state_dir / "starting.lock"
    lock_fd = None
    for _ in range(100):
        try:
            lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            if status(settings, path):
                print("Already running")
                return
            time.sleep(0.1)
    if lock_fd is None:
        raise ValueError("Startup still in progress; inspect .local/starting.lock if interrupted")
    os.close(lock_fd)
    try:
        with (settings.state_dir / "server.log").open("ab") as log:
            process = subprocess.Popen(server_command(path),
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


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def _upgrade_command(args, path: Path) -> None:
    from .changes.content import KeyringKeyProvider, ProtectedContentStore
    from .upgrade import UpgradeManager, _changes_fingerprint

    require_no_pending_reset(path)
    if args.runtime_dir is None:
        raise ValueError("--runtime-dir is required for upgrade commands")
    state = (args.state_dir or path.parent / ".local").resolve()
    if args.command == "upgrade-prepare":
        raw = json.loads(path.read_text(encoding="utf-8"))
    else:
        if not args.snapshot_id:
            raise ValueError("--snapshot-id is required")
        if not re.fullmatch(r"[0-9a-f]{32}", args.snapshot_id):
            raise ValueError("invalid snapshot id")
        snapshot_config = state / "upgrade-snapshots" / args.snapshot_id / "config.json"
        raw = json.loads(snapshot_config.read_text(encoding="utf-8"))
    admin_port = int(raw.get("admin_port", 8766))
    identity = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
    content = (ProtectedContentStore(
        state / "changes" / "content", KeyringKeyProvider(identity),
    ) if args.command == "upgrade-prepare" else None)
    manager = UpgradeManager(
        path, state, args.runtime_dir, content_store=content,
        is_running=lambda: _port_open(admin_port),
    )
    if args.command == "upgrade-prepare":
        if not args.target_version:
            raise ValueError("--target-version is required")
        print(manager.prepare_upgrade(args.target_version))
    elif args.command == "upgrade-restore":
        manager.restore_snapshot(args.snapshot_id)
        print("Snapshot restored; project files were not changed")
    elif args.command == "upgrade-rollback":
        manager.rollback_verified_snapshot(args.snapshot_id)
        print("Verified snapshot restored; project files were not changed")
    elif args.command == "upgrade-finalize":
        manager.finalize_upgrade(args.snapshot_id, health_check=lambda: bool(status(load_config(path), path)))
        print("Upgrade verified and finalized")
    else:
        manager.complete_upgrade(args.snapshot_id, health_check=lambda: (
            (manager.runtime_dir / "porthole.exe").is_file()
            and isinstance(_changes_fingerprint(manager.db_path), list)
        ))
        print("Offline upgrade checks passed; start the service and verify connection")


def _grant_command(command, path):
    with reset_lock(path):
        require_no_pending_reset(path)
        settings = load_config(path)
        if command == "credential-store":
            from .auth import store_github_credentials

            payload = sys.stdin.read(16_385)
            if len(payload) > 16_384:
                raise ValueError("credential input too large")
            credentials = json.loads(payload)
            if not isinstance(credentials, dict):
                raise ValueError("credential input must be an object")
            store_github_credentials(settings.state_dir,
                                     credentials.get("client_id"), credentials.get("client_secret"))
            print("Credentials stored in the operating system vault")
        else:
            from .pairing import PairingStore

            result = PairingStore(settings.state_dir).issue()
            print(json.dumps({
                **result,
                "service_url": f"http://127.0.0.1:{settings.admin_port}",
            }))


def _profile_lease(path, expected_reset_id):
    reject_links(path)
    if not path.is_file():
        raise ResetError("RESET_CONFIG_UNAVAILABLE", "Configuration is missing; initialize it before editing")
    require_no_pending_reset(path)
    generation = reset_generation(path)
    if (expected_reset_id is not None and expected_reset_id != "none"
            and not re.fullmatch(r"[0-9a-f]{32}", expected_reset_id)):
        raise ResetError("RESET_STATE_UNAVAILABLE", "Invalid expected reset generation")
    with profile_edit_lock(path, timeout=1):
        require_no_pending_reset(path)
        current = reset_generation(path)
        expected = None if expected_reset_id == "none" else expected_reset_id
        if current != generation or (expected_reset_id is not None and current != expected):
            raise ResetError("RESET_PENDING", "Reset invalidated this profile edit; retry explicitly")
        print(json.dumps({"ready": True}), flush=True)
        while sys.stdin.read(4096):
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local Project Assistant")
    parser.add_argument("command", choices=[
        "init", "serve", "start", "stop", "status", "doctor", "token", "pair",
        "diagnostics-preview", "diagnostics-export",
        "upgrade-prepare", "upgrade-restore", "upgrade-complete", "upgrade-finalize",
        "upgrade-rollback",
        "credential-store", "credential-clear",
        "reset-check", "reset-local",
        "profile-lease",
    ])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--id", default="current")
    parser.add_argument("--kind", choices=["admin", "mcp"], default="admin")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--include-paths", action="store_true")
    parser.add_argument("--runtime-dir", type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--snapshot-id")
    parser.add_argument("--target-version")
    parser.add_argument("--expected-reset-id")
    args = parser.parse_args(argv)
    path = (args.config or default_config_path()).absolute()
    try:
        if args.command == "profile-lease":
            _profile_lease(path, args.expected_reset_id)
            return 0
        if args.command in {"reset-check", "reset-local"}:
            if args.command == "reset-local":
                with reset_lock(path), profile_edit_lock(path, timeout=RESET_PROFILE_LOCK_TIMEOUT):
                    result = LocalReset(path).run()
            else:
                with profile_edit_lock(path, timeout=RESET_PROFILE_LOCK_TIMEOUT):
                    result = LocalReset(path).check()
            print(json.dumps(result))
            return 0
        if args.command in {"start", "serve", "pair", "credential-store"}:
            require_no_pending_reset(path)
        path = path.resolve()
        if args.command == "init":
            if path.exists():
                raise ValueError("Configuration already exists; refusing to overwrite")
            settings = Settings(projects=[{"id": args.id, "root": args.project.resolve()}])
            path.parent.mkdir(parents=True, exist_ok=True)
            save_config(path, settings)
            load_config(path)
            print(f"Initialized: {path}")
            return 0
        if args.command.startswith("upgrade-"):
            _upgrade_command(args, path)
            return 0
        if args.command in {"pair", "credential-store"}:
            _grant_command(args.command, path)
            return 0
        settings = load_config(path)
        if args.command == "credential-clear":
            from .auth import clear_github_credentials

            clear_github_credentials(settings.state_dir)
            print("Credentials removed from the operating system vault")
        elif args.command == "serve":
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
                "local_service": "Run porthole start and inspect the local log if it fails.",
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
        elif args.command in {"diagnostics-preview", "diagnostics-export"}:
            from .diagnostics import Diagnostics
            from .protocol import service_info

            diagnostics = Diagnostics(
                settings.state_dir / "diagnostics",
                details_provider=lambda: {
                    "service": service_info().model_dump(mode="json"),
                    "projects": [
                        {"id": project.id, "root": str(project.root)}
                        for project in settings.projects
                    ],
                },
            )
            if args.command == "diagnostics-preview":
                print(json.dumps(diagnostics.preview_export(
                    include_paths=args.include_paths,
                ), ensure_ascii=False, indent=2))
            else:
                target = (args.output or Path.cwd() / "porthole-diagnostics.zip").resolve()
                print(diagnostics.export_diagnostics(
                    target, include_paths=args.include_paths,
                ))
        return 0
    except ResetError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (ValueError, OSError, httpx.HTTPError, UpgradeError, StorageUnavailable) as exc:
        if args.command in {"reset-check", "reset-local", "profile-lease"}:
            print("RESET_STATE_UNAVAILABLE: Local reset could not complete; resume after inspection", file=sys.stderr)
            return 2
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
