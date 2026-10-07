from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import keyring
import pytest
from keyring.errors import PasswordDeleteError
from starlette.testclient import TestClient

from project_mcp import cli
from project_mcp.auth import _vault_service
from project_mcp.config import Settings, load_config, save_config
from project_mcp.server import Runtime, create_admin_app, create_mcp


def command(config, name):
    try:
        return cli.main([name, "--config", str(config)])
    except SystemExit as exc:
        return exc.code


@pytest.fixture
def local(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    (root / "source.txt").write_bytes(b"business source remains intact")
    ports = []
    for _ in range(2):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            ports.append(sock.getsockname()[1])
    config = tmp_path / "config.json"
    save_config(config, Settings(projects=[{"id": "demo", "root": root}],
                                mcp_port=ports[0], admin_port=ports[1]))
    settings = load_config(config)
    state = settings.state_dir
    vault = {(_vault_service(state), "client_id"): "id",
             (_vault_service(state), "client_secret"): "private",
             ("content encryption", "key"): "must remain"}
    monkeypatch.setattr(keyring, "get_password", lambda service, name: vault.get((service, name)))
    def delete(service, name):
        if (service, name) not in vault:
            raise PasswordDeleteError("not present")
        del vault[(service, name)]
    monkeypatch.setattr(keyring, "delete_password", delete)
    return config, settings, root, vault


def test_reset_check_is_readonly_even_without_tokens(tmp_path, capsys):
    config = tmp_path / "config.json"
    save_config(config, Settings(mcp_port=32189, admin_port=32190))
    before = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert command(config, "reset-check") == 0
    assert json.loads(capsys.readouterr().out) == {"ready": True, "reset_id": None}
    assert {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*")
            if p.is_file() and p.name != ".profile-edit.lock"} == before
    assert not (tmp_path / ".local").exists()


def test_reset_revokes_local_auth_and_preserves_source_history_runtime(local, capsys):
    config, settings, root, vault = local
    state = settings.state_dir
    old_tokens = (state / "tokens.json").read_bytes()
    for name in ("oauth", "diagnostics"):
        (state / name).mkdir()
        (state / name / "private.json").write_text("private")
    for name in ("pairing.json", "verification-history.json"):
        (state / name).write_text("private")
    (state / "changes" / "content").mkdir(parents=True)
    history = state / "changes" / "content" / "protected.blob"
    history.write_bytes(b"protected history")
    arbitrary = state / "business-data.txt"
    arbitrary.write_bytes(b"never delete state wholesale")
    runtime = config.parent / "runtime" / "current"
    runtime.mkdir(parents=True)
    (runtime / "porthole.exe").write_bytes(b"installed runtime")
    assert command(config, "reset-local") == 0
    result = json.loads(capsys.readouterr().out)
    assert result["local_reset"] is True
    assert result["reset_id"]
    raw = json.loads(config.read_text())
    assert raw["projects"] == []
    assert raw["auth_mode"] == "local"
    assert raw["github_user_ids"] == [] and raw["public_url"] is None
    assert (state / "tokens.json").read_bytes() != old_tokens
    assert all(secret not in json.dumps(result) for secret in json.loads(old_tokens).values())
    assert not any((state / name).exists() for name in (
        "oauth", "diagnostics", "pairing.json", "verification-history.json"))
    assert history.read_bytes() == b"protected history"
    assert arbitrary.read_bytes() == b"never delete state wholesale"
    assert (root / "source.txt").read_bytes() == b"business source remains intact"
    assert (runtime / "porthole.exe").read_bytes() == b"installed runtime"
    assert vault == {("content encryption", "key"): "must remain"}
    receipt = json.loads((config.parent / ".reset-receipt.json").read_text())
    assert receipt["reset_id"] == result["reset_id"] and receipt["completed_at"]
    assert not (config.parent / ".reset-in-progress.json").exists()
    new_tokens = (state / "tokens.json").read_bytes()
    assert command(config, "reset-local") == 0
    assert json.loads(capsys.readouterr().out) == result
    assert (state / "tokens.json").read_bytes() == new_tokens


def test_vault_failure_preserves_checkpoint_and_can_resume(local, monkeypatch, capsys):
    config, _settings, _root, vault = local
    original = keyring.delete_password
    monkeypatch.setattr(keyring, "delete_password", lambda *args: (_ for _ in ()).throw(RuntimeError("private-secret")))
    assert command(config, "reset-local") == 2
    output = capsys.readouterr()
    assert "RESET_VAULT_UNAVAILABLE" in output.err and "private-secret" not in output.err
    marker = config.parent / ".reset-in-progress.json"
    checkpoint = json.loads(marker.read_text())
    assert command(config, "start") == 2
    assert "RESET_PENDING" in capsys.readouterr().err
    monkeypatch.setattr(keyring, "delete_password", original)
    assert command(config, "reset-check") == 0
    assert json.loads(capsys.readouterr().out)["reset_id"] == checkpoint["reset_id"]
    assert command(config, "reset-local") == 0
    assert json.loads(capsys.readouterr().out)["reset_id"] == checkpoint["reset_id"]
    assert vault == {("content encryption", "key"): "must remain"}


@pytest.mark.parametrize("state_name", ["applying", "reverting", "recovery_required"])
def test_unsafe_change_states_block_reset_without_changes(local, capsys, state_name):
    config, settings, _root, _vault = local
    db = settings.state_dir / "changes" / "changes.db"
    db.parent.mkdir()
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE changes (change_id TEXT, revision INTEGER, state TEXT)")
        connection.execute("INSERT INTO changes VALUES ('c', 1, ?)", (state_name,))
    before = config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes(), db.read_bytes()
    assert command(config, "reset-local") == 2
    assert "RESET_BUSY" in capsys.readouterr().err
    assert before == (config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes(), db.read_bytes())
    assert not (config.parent / ".reset-in-progress.json").exists()


def test_upgrade_marker_blocks_reset(local, capsys):
    config, settings, _root, _vault = local
    (settings.state_dir / "upgrade-in-progress.json").write_text('{"phase":"awaiting_verification"}')
    assert command(config, "reset-check") == 2
    assert "RESET_BUSY" in capsys.readouterr().err
    assert not (config.parent / ".reset-in-progress.json").exists()


def test_unrelated_listener_is_never_stopped_or_cleared(local, capsys):
    config, settings, _root, _vault = local
    before = config.read_bytes()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", settings.mcp_port))
        sock.listen()
        assert command(config, "reset-local") == 2
        assert "RESET_PORT_IN_USE" in capsys.readouterr().err
        assert config.read_bytes() == before
        assert sock.getsockname()[1] == settings.mcp_port


def test_owned_directory_junction_blocks_reset(local, tmp_path, capsys):
    config, settings, _root, _vault = local
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "keep.txt"
    secret.write_bytes(b"unrelated data")
    link = settings.state_dir / "oauth"
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, check=False)
        if result.returncode:
            pytest.skip("junction creation unavailable")
    else:
        link.symlink_to(outside, target_is_directory=True)
    try:
        assert command(config, "reset-local") == 2
        assert "RESET_UNSAFE_PATH" in capsys.readouterr().err
        assert secret.read_bytes() == b"unrelated data"
        assert not (config.parent / ".reset-in-progress.json").exists()
    finally:
        if os.name == "nt":
            link.rmdir()
        else:
            link.unlink()


def test_live_prepare_rejects_active_reads_then_gates_admin_and_mcp(local):
    config, settings, _root, _vault = local
    runtime = Runtime(settings, config)
    with TestClient(create_admin_app(runtime), base_url=f"http://127.0.0.1:{settings.admin_port}") as client:
        headers = {"Authorization": "Bearer " + settings.admin_token}
        runtime.limits.read.active = 1
        busy = client.post("/api/reset/prepare", headers=headers)
        assert busy.status_code == 409 and busy.json()["error_code"] == "RESET_BUSY"
        assert not (config.parent / ".reset-in-progress.json").exists()
        runtime.limits.read.active = 0
        prepared = client.post("/api/reset/prepare", headers=headers)
        assert prepared.status_code == 200 and prepared.json()["reset_id"]
        assert client.put("/api/projects", headers=headers, json={"id": "other", "root": str(_root)}).status_code == 409
        assert client.post("/api/pair", json={"pairing_code": "no"}).status_code == 409
        assert client.get("/api/status", headers=headers).status_code == 200
        assert client.post("/api/shutdown", headers=headers).status_code == 200
    with pytest.raises(RuntimeError, match="RESET_PENDING"):
        runtime.projects()
    async def tools():
        from fastmcp import Client
        async with Client(create_mcp(runtime)) as client:
            assert "initial_reset" not in {tool.name for tool in await client.list_tools()}
            with pytest.raises(Exception, match="RESET_PENDING"):
                await client.call_tool("list_files", {"project_id": "demo"})
    asyncio.run(tools())


def test_prepare_requires_admin_auth_and_loopback_host(local):
    config, settings, _root, _vault = local
    runtime = Runtime(settings, config)
    with TestClient(create_admin_app(runtime), base_url=f"http://127.0.0.1:{settings.admin_port}") as client:
        assert client.post("/api/reset/prepare").status_code == 401
        assert client.post("/api/reset/prepare", headers={"Authorization": "Bearer " + settings.admin_token, "Host": "remote.invalid"}).status_code == 403
    assert not (config.parent / ".reset-in-progress.json").exists()


def test_snapshot_from_before_reset_cannot_restore_grants(local):
    from test_upgrade import setup_upgrade

    from project_mcp.upgrade import UpgradeError
    config, _settings, _root, _vault = local
    (config.parent / "upgrade-case").mkdir()
    manager, _store, _content, _config, _root = setup_upgrade(config.parent / "upgrade-case")
    snapshot_id = manager.prepare_upgrade("0.3")
    # A retained older backup must not restore the old project grant after reset.
    manager.marker.unlink()
    (manager.config_path.parent / ".reset-receipt.json").write_text('{"reset_id":"11111111111111111111111111111111","completed_at":"now"}')
    with pytest.raises(UpgradeError, match="reset generation"):
        manager.restore_snapshot(snapshot_id)


def test_live_legacy_service_requires_bundled_upgrade_without_mutation(local, monkeypatch, capsys):
    config, settings, _root, _vault = local
    payload = {"config_id": hashlib.sha256(str(config.resolve()).encode()).hexdigest(), "capabilities": []}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: httpx.Response(200, json=payload))
    before = config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes()
    for name in ("reset-check", "reset-local"):
        assert command(config, name) == 2
        output = capsys.readouterr()
        assert output.out == "" and "RESET_INCOMPATIBLE" in output.err and "bundled" in output.err
    assert before == (config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes())
    assert not (config.parent / ".reset-in-progress.json").exists()


@pytest.mark.parametrize("name", ["serve", "start"])
def test_stale_startup_cannot_revive_service_after_reset(local, monkeypatch, capsys, name):
    from project_mcp.reset import ResetError
    config, stale_settings, _root, _vault = local
    assert command(config, "reset-local") == 0
    capsys.readouterr()
    async def observe(settings, path):
        pytest.fail("A stale startup must not start after reset completion")
    monkeypatch.setattr(cli, "_serve", observe)
    with pytest.raises(ResetError, match="RESET_PENDING"):
        if name == "serve":
            asyncio.run(cli.serve(stale_settings, config))
        else:
            cli.start(stale_settings, config)


@pytest.mark.parametrize("name", ["serve", "upgrade-prepare", "upgrade-restore", "credential-store", "pair"])
def test_pending_marker_blocks_lifecycle_and_new_local_grants(local, capsys, name):
    config, settings, _root, _vault = local
    (config.parent / ".reset-in-progress.json").write_text('{"reset_id":"pending"}')
    before = config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes()
    assert command(config, name) == 2
    assert "RESET_PENDING" in capsys.readouterr().err
    assert before == (config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes())
    assert not (settings.state_dir / "pairing.json").exists()


def test_reauthorized_config_uses_new_receipt_generation(local, capsys):
    config, _settings, root, _vault = local
    assert command(config, "reset-local") == 0
    first = json.loads(capsys.readouterr().out)
    raw = json.loads(config.read_text())
    raw["projects"] = [{"id": "demo", "root": str(root)}]
    config.write_text(json.dumps(raw))
    assert command(config, "reset-local") == 0
    second = json.loads(capsys.readouterr().out)
    assert second["reset_id"] != first["reset_id"]
    assert json.loads(config.read_text())["projects"] == []


def test_restored_vault_credentials_trigger_new_reset_generation(local, capsys):
    config, settings, _root, vault = local
    assert command(config, "reset-local") == 0
    first = json.loads(capsys.readouterr().out)
    vault[(_vault_service(settings.state_dir), "client_secret")] = "new credential"
    assert command(config, "reset-local") == 0
    second = json.loads(capsys.readouterr().out)
    assert first["reset_id"] != second["reset_id"]
    assert vault == {("content encryption", "key"): "must remain"}


def test_vault_delete_refusal_is_not_treated_as_missing(local, monkeypatch, capsys):
    config, _settings, _root, _vault = local
    monkeypatch.setattr(keyring, "delete_password", lambda *a: (_ for _ in ()).throw(PasswordDeleteError("access denied")))
    assert command(config, "reset-local") == 2
    assert "RESET_VAULT_UNAVAILABLE" in capsys.readouterr().err
    assert (config.parent / ".reset-in-progress.json").exists()


def test_live_reset_stops_service_old_tokens_fail_and_restart_has_no_grants(local, capsys):
    from test_cli import invoke
    config, settings, _root, _vault = local
    started = invoke("start", "--config", config)
    assert started.returncode == 0, started.stderr
    try:
        assert command(config, "reset-check") == 0
        assert json.loads(capsys.readouterr().out)["ready"] is True
        assert command(config, "reset-local") == 0
        assert json.loads(capsys.readouterr().out)["local_reset"] is True
        assert invoke("status", "--config", config).returncode == 1
        restarted = invoke("start", "--config", config)
        assert restarted.returncode == 0, restarted.stderr
        old = httpx.get(f"http://127.0.0.1:{settings.admin_port}/api/status",
                        headers={"Authorization": "Bearer " + settings.admin_token}, trust_env=False)
        assert old.status_code == 401
        new_status = json.loads(invoke("status", "--config", config).stdout)
        assert new_status["projects"] == []
        async def old_mcp():
            from fastmcp import Client
            with pytest.raises((httpx.HTTPStatusError, RuntimeError)):
                async with Client(f"http://127.0.0.1:{settings.mcp_port}/mcp", auth=settings.mcp_token) as client:
                    await client.call_tool("list_projects", {})
        asyncio.run(old_mcp())
    finally:
        stopped = invoke("stop", "--config", config)
        assert stopped.returncode == 0, stopped.stderr


def test_pair_waits_for_reset_transaction_and_rechecks_pending(local):
    config, settings, _root, _vault = local
    lock = config.parent / ".reset.lock"
    with lock.open("w+b") as stream:
        stream.write(b"0")
        stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
        process = subprocess.Popen([sys.executable, "-m", "project_mcp.cli", "pair", "--config", str(config)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        try:
            time.sleep(2)
            assert process.poll() is None
            (config.parent / ".reset-in-progress.json").write_text('{"reset_id":"pending"}')
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)
            out, err = process.communicate(timeout=15)
    assert process.returncode == 2 and "RESET_PENDING" in err and out == ""
    assert not (settings.state_dir / "pairing.json").exists()


def test_unknown_checkpoint_phase_is_rejected(local, capsys):
    from project_mcp.reset import LocalReset
    config, settings, _root, _vault = local
    reset = LocalReset(config)
    reset.prepare()
    checkpoint = json.loads(reset.marker.read_text())
    checkpoint["phase"] = "corrupted"
    reset.marker.write_text(json.dumps(checkpoint))
    tokens = (settings.state_dir / "tokens.json").read_bytes()
    assert command(config, "reset-local") == 2
    assert "RESET_STATE_UNAVAILABLE" in capsys.readouterr().err
    assert (settings.state_dir / "tokens.json").read_bytes() == tokens
    assert reset.marker.exists()


def test_reset_check_does_not_create_sqlite_wal_sidecars(local, capsys):
    config, settings, _root, _vault = local
    database = settings.state_dir / "changes" / "changes.db"
    database.parent.mkdir()
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE changes (state TEXT)")
    connection.commit()
    connection.close()
    before = {p.relative_to(settings.state_dir): p.read_bytes()
              for p in settings.state_dir.rglob("*") if p.is_file()}
    assert command(config, "reset-check") == 0
    capsys.readouterr()
    after = {p.relative_to(settings.state_dir): p.read_bytes()
             for p in settings.state_dir.rglob("*") if p.is_file()}
    assert after == before


def test_reset_removes_grants_for_missing_project_directory(local, capsys):
    config, _settings, root, _vault = local
    (root / "source.txt").unlink()
    root.rmdir()
    assert command(config, "reset-check") == 0
    capsys.readouterr()
    assert command(config, "reset-local") == 0
    assert json.loads(capsys.readouterr().out)["local_reset"] is True
    assert json.loads(config.read_text())["projects"] == []


def test_malformed_reset_identity_is_rejected_before_mutation(local, capsys):
    from project_mcp.reset import LocalReset
    config, settings, _root, _vault = local
    reset = LocalReset(config)
    reset.prepare()
    marker = json.loads(reset.marker.read_text())
    marker["reset_id"] = "../invalid"
    reset.marker.write_text(json.dumps(marker))
    old_tokens = (settings.state_dir / "tokens.json").read_bytes()
    assert command(config, "reset-local") == 2
    assert "RESET_STATE_UNAVAILABLE" in capsys.readouterr().err
    assert (settings.state_dir / "tokens.json").read_bytes() == old_tokens


def test_reset_check_reads_unsafe_wal_without_modifying_history(local, capsys):
    config, settings, _root, _vault = local
    database = settings.state_dir / "changes" / "changes.db"
    database.parent.mkdir()
    connection = sqlite3.connect(database)
    try:
        connection.execute("CREATE TABLE changes (state TEXT)")
        connection.commit()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("INSERT INTO changes VALUES ('applying')")
        connection.commit()
        before = {p.name: p.read_bytes() for p in database.parent.iterdir()}
        assert command(config, "reset-check") == 2
        assert "RESET_BUSY" in capsys.readouterr().err
        assert {p.name: p.read_bytes() for p in database.parent.iterdir()} == before
    finally:
        connection.close()


def test_slow_status_safety_check_does_not_hold_profile_lock(local, monkeypatch):
    from project_mcp.reset import profile_edit_lock
    config, settings, _root, _vault = local
    runtime = Runtime(settings, config)
    entered, release = threading.Event(), threading.Event()

    def slow_check():
        entered.set()
        assert release.wait(5), "Status safety barrier timed out"
        return True

    monkeypatch.setattr(runtime, "reset_operations_idle", slow_check)
    with ThreadPoolExecutor(max_workers=1) as pool:
        status = pool.submit(runtime.reset_ready)
        try:
            assert entered.wait(5)
            with profile_edit_lock(config):
                pass
        finally:
            release.set()
        assert status.result(timeout=5) is True


@pytest.mark.parametrize("entry", ["cli-check", "cli-local", "direct-check", "direct-local"])
def test_reset_waits_for_brief_profile_lock_contention(local, capsys, monkeypatch, entry):
    from project_mcp import reset
    config, _settings, _root, _vault = local
    local_reset = reset.LocalReset(config)
    acquired, release, released = threading.Event(), threading.Event(), threading.Event()

    def holder():
        try:
            with reset.profile_edit_lock(config):
                acquired.set()
                assert release.wait(5), "Profile contention barrier timed out"
        finally:
            released.set()

    def release_on_lock_retry(_interval):
        release.set()
        assert released.wait(5), "Profile lock did not release"

    with ThreadPoolExecutor(max_workers=1) as pool:
        holding = pool.submit(holder)
        try:
            assert acquired.wait(5)
            # Release only after the OS reports contention, without timing-dependent sleeps.
            monkeypatch.setattr(reset.time, "sleep", release_on_lock_retry)
            if entry.startswith("cli-"):
                name = "reset-check" if entry == "cli-check" else "reset-local"
                assert command(config, name) == 0
                assert json.loads(capsys.readouterr().out)
            else:
                result = local_reset.check() if entry == "direct-check" else local_reset.run()
                assert result
            assert release.is_set()
        finally:
            release.set()
        holding.result(timeout=5)


@pytest.mark.parametrize("name", ["reset-check", "reset-local"])
def test_reset_held_profile_lock_does_not_initialize_config_or_credentials(tmp_path, capsys, monkeypatch, name):
    from project_mcp.reset import profile_edit_lock
    config = tmp_path / "config.json"
    config.write_bytes(b"invalid configuration must not be parsed while an edit owns it")
    acquired, release = threading.Event(), threading.Event()

    def holder():
        with profile_edit_lock(config):
            acquired.set()
            assert release.wait(5), "Profile lease barrier timed out"

    def forbidden_reset(_config):
        raise AssertionError("Reset initialized before acquiring the profile lock")

    monkeypatch.setattr(cli, "LocalReset", forbidden_reset)
    with ThreadPoolExecutor(max_workers=1) as pool:
        holding = pool.submit(holder)
        try:
            assert acquired.wait(5)
            assert command(config, name) == 2
            output = capsys.readouterr()
            assert output.out == "" and "RESET_BUSY" in output.err
            assert config.read_bytes() == b"invalid configuration must not be parsed while an edit owns it"
            assert not (tmp_path / ".local").exists()
        finally:
            release.set()
        holding.result(timeout=5)


def lease_process(config, *extra):
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
    pid_path = config.parent / f".lease-test-pid-{uuid.uuid4().hex}"
    # Windows venv python.exe is a redirector; identify the interpreter that holds the lease.
    bootstrap = (
        "import os, sys; from pathlib import Path; "
        "Path(sys.argv[1]).write_text(str(os.getpid())); "
        "from project_mcp.cli import main; raise SystemExit(main(sys.argv[2:]))"
    )
    process = subprocess.Popen([sys.executable, "-c", bootstrap, str(pid_path),
                                "profile-lease", "--config", str(config), *extra],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=env)
    process.runtime_pid_path = pid_path
    return process


def terminate_lease_runtime(lease):
    """Crash and wait for the exact owned lease holder, including Windows redirector children."""
    pid = int(lease.runtime_pid_path.read_text())
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.TerminateProcess.restype = wintypes.BOOL
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
        assert handle, f"Unable to open owned interpreter PID {pid}"
        try:
            assert kernel.TerminateProcess(handle, 1)
            assert kernel.WaitForSingleObject(handle, 5000) == 0
        finally:
            kernel.CloseHandle(handle)
    else:
        import signal
        os.kill(pid, signal.SIGKILL)
    lease.wait(timeout=5)


@pytest.mark.parametrize("release", ["eof", "crash"])
def test_profile_lease_blocks_all_reset_paths_and_releases(local, capsys, release):
    config, settings, _root, _vault = local
    lease = lease_process(config)
    try:
        assert json.loads(lease.stdout.readline()) == {"ready": True}
        before = config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes()
        for name in ("reset-check", "reset-local"):
            assert command(config, name) == 2
            assert "RESET_BUSY" in capsys.readouterr().err
        runtime = Runtime(settings, config)
        assert runtime.reset_ready() is False
        with TestClient(create_admin_app(runtime), base_url=f"http://127.0.0.1:{settings.admin_port}") as client:
            result = client.post("/api/reset/prepare", headers={"Authorization": "Bearer " + settings.admin_token})
            assert result.status_code == 409 and result.json()["error_code"] == "RESET_BUSY"
        assert not (config.parent / ".reset-in-progress.json").exists()
        assert before == (config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes())
        if release == "eof":
            lease.stdin.close()
        else:
            terminate_lease_runtime(lease)
        lease.wait(timeout=5)
        assert command(config, "reset-check") == 0
        assert json.loads(capsys.readouterr().out)["ready"] is True
    finally:
        if lease.poll() is None:
            terminate_lease_runtime(lease)


def test_pending_reset_prevents_profile_lease(local):
    config, settings, _root, _vault = local
    (config.parent / ".reset-in-progress.json").write_text('{"reset_id":"pending"}')
    before = config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes()
    lease = lease_process(config)
    out, err = lease.communicate(timeout=5)
    assert lease.returncode == 2 and out == "" and "RESET_PENDING" in err
    assert before == (config.read_bytes(), (settings.state_dir / "tokens.json").read_bytes())


def test_profile_lease_does_not_parse_config_or_initialize_credentials(tmp_path):
    config = tmp_path / "config.json"
    config.write_bytes(b"broken configuration does not need reading for a lease")
    lease = lease_process(config)
    try:
        assert json.loads(lease.stdout.readline()) == {"ready": True}
        assert config.read_bytes() == b"broken configuration does not need reading for a lease"
        assert not (tmp_path / ".local").exists()
        lease.stdin.close()
        assert lease.wait(timeout=5) == 0
    finally:
        if lease.poll() is None:
            terminate_lease_runtime(lease)


def test_missing_configuration_prevents_profile_lease(tmp_path):
    lease = lease_process(tmp_path / "config.json")
    out, err = lease.communicate(timeout=5)
    assert lease.returncode == 2 and out == "" and "RESET_CONFIG_UNAVAILABLE" in err
    assert not (tmp_path / ".profile-edit.lock").exists()


@pytest.mark.parametrize("expected", ["none", "22222222222222222222222222222222", "invalid"])
def test_profile_lease_rejects_stale_or_invalid_expected_generation(local, expected):
    config, _settings, _root, _vault = local
    (config.parent / ".reset-receipt.json").write_text('{"reset_id":"11111111111111111111111111111111","completed_at":"now"}')
    lease = lease_process(config, "--expected-reset-id", expected)
    out, err = lease.communicate(timeout=5)
    code = "RESET_STATE_UNAVAILABLE" if expected == "invalid" else "RESET_PENDING"
    assert lease.returncode == 2 and out == "" and code in err


def test_profile_lease_accepts_current_expected_generation(local):
    config, _settings, _root, _vault = local
    (config.parent / ".reset-receipt.json").write_text('{"reset_id":"11111111111111111111111111111111","completed_at":"now"}')
    lease = lease_process(config, "--expected-reset-id", "11111111111111111111111111111111")
    try:
        assert json.loads(lease.stdout.readline()) == {"ready": True}
        lease.stdin.close()
        assert lease.wait(timeout=5) == 0
    finally:
        if lease.poll() is None:
            terminate_lease_runtime(lease)


def test_failed_live_prepare_marker_blocks_new_operations_and_can_retry(local):
    from project_mcp.reset import LocalReset, ResetError
    config, settings, root, _vault = local
    runtime = Runtime(settings, config)
    with runtime.operation():
        checkpoint = LocalReset(config).prepare()
        with pytest.raises(ResetError, match="RESET_BUSY"):
            runtime.prepare_reset()
        assert runtime.quiesced is False
    with pytest.raises(ResetError, match="RESET_PENDING"), runtime.operation():
        runtime.update_project({"id": "new", "root": root})
    assert [project.id for project in runtime.settings.projects] == ["demo"]
    async def read():
        from fastmcp import Client
        async with Client(create_mcp(runtime)) as client:
            with pytest.raises(Exception, match="RESET_PENDING"):
                await client.call_tool("read_file", {"project_id": "demo", "path": "source.txt"})
    asyncio.run(read())
    assert runtime.prepare_reset() == checkpoint
    assert runtime.quiesced is True
