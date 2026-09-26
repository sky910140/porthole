"""Exercise 0.3.1 -> 0.4.0 upgrade and rollback in a temporary Windows user root."""

from __future__ import annotations

import hashlib
import json
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

import keyring
from keyring.errors import PasswordDeleteError


def free_port() -> int:
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def run(executable: Path, *arguments: str) -> str:
    result = subprocess.run([str(executable), *map(str, arguments)], capture_output=True,
                            text=True, timeout=60, check=False)
    if result.returncode:
        raise AssertionError(f"{executable.name} {arguments[0]}: {result.stderr or result.stdout}")
    return result.stdout.strip()


def install(bundle: Path, runtime: Path, version: str) -> None:
    script = ("const m=require(process.argv[1]);"
              "m.installBundledRuntime(process.argv[2],process.argv[3],process.argv[4]);")
    result = subprocess.run(["node", "-e", script, str(bundle.parent / "lib" / "service-manager.js"),
                             str(bundle), str(runtime), version], capture_output=True, text=True,
                            timeout=120, check=False)
    if result.returncode:
        raise AssertionError(result.stderr or result.stdout)


def verify(old_vsix: Path, new_vsix: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="ai-zhagan-upgrade-") as directory:
        root = Path(directory)
        old = root / "old"
        new = root / "new"
        with ZipFile(old_vsix) as archive:
            archive.extractall(old)
        with ZipFile(new_vsix) as archive:
            archive.extractall(new)
        old_extension = old / "extension"
        new_extension = new / "extension"
        runtime = root / "user" / "runtime" / "current"
        config = root / "user" / "config.json"
        state = root / "user" / ".local"
        project = root / "project"
        project.mkdir()
        (project / "README.md").write_text("# preserved\n", encoding="utf-8")
        install(old_extension / "runtime-bundle", runtime, "0.3.1")
        old_exe = runtime / "ai-zhagan.exe"
        run(old_exe, "init", "--config", config, "--project", project, "--id", "demo")
        value = json.loads(config.read_text(encoding="utf-8"))
        value.update(mcp_port=free_port(), admin_port=free_port())
        config.write_text(json.dumps(value), encoding="utf-8")
        upgrade_args = ("--config", config, "--runtime-dir", runtime, "--state-dir", state)
        identity = hashlib.sha256(str(config.resolve()).encode()).hexdigest()
        try:
            run(old_exe, "start", "--config", config)
            run(old_exe, "stop", "--config", config)
            snapshot_id = run(old_exe, "upgrade-prepare", *upgrade_args, "--target-version", "0.3")
            assert len(snapshot_id) == 32
            install(new_extension / "runtime-bundle", runtime, "0.4.0")
            new_exe = runtime / "ai-zhagan.exe"
            run(new_exe, "upgrade-complete", *upgrade_args, "--snapshot-id", snapshot_id)
            run(new_exe, "start", "--config", config)
            assert json.loads(run(new_exe, "status", "--config", config))["service_version"] == "0.4.0"
            run(new_exe, "upgrade-finalize", *upgrade_args, "--snapshot-id", snapshot_id)
            run(new_exe, "stop", "--config", config)
            runner = root / "rollback-runner"
            shutil.copytree(runtime, runner)
            run(runner / "ai-zhagan.exe", "upgrade-rollback", *upgrade_args,
                "--snapshot-id", snapshot_id)
            assert json.loads((runtime / "installed.json").read_text())["version"] == "0.3.1"
            run(runtime / "ai-zhagan.exe", "start", "--config", config)
            assert json.loads(run(runtime / "ai-zhagan.exe", "status", "--config", config))[
                "service_version"] == "0.3.1"
            run(runtime / "ai-zhagan.exe", "stop", "--config", config)
            assert (project / "README.md").read_text(encoding="utf-8") == "# preserved\n"
            print("Isolated 0.3.1 -> 0.4.0 upgrade, live status, and guarded rollback: passed")
        finally:
            if config.exists() and (runtime / "ai-zhagan.exe").exists():
                subprocess.run([str(runtime / "ai-zhagan.exe"), "stop", "--config", str(config)],
                               capture_output=True, timeout=15, check=False)
            try:
                keyring.delete_password("AI Zhagan protected content", identity)
            except PasswordDeleteError:
                pass


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
