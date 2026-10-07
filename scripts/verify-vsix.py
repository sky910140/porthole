"""Exercise the packaged VSIX's bundled runtime in an isolated user directory."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def verify(vsix: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="porthole-vsix-") as raw:
        root = Path(raw)
        with ZipFile(vsix) as archive:
            names = archive.namelist()
            if not any(name == "extension/runtime-bundle/bundle.json" for name in names):
                raise AssertionError("VSIX does not contain a runtime manifest")
            if "extension/tunnel-bundle/bundle.json" not in names:
                raise AssertionError("VSIX does not contain the official tunnel bundle")
            for name in ("LICENSE", "NOTICE", "oss-license-report-client.txt"):
                if f"extension/tunnel-bundle/{name}" not in names:
                    raise AssertionError("VSIX does not contain tunnel notices")
            for name in names:
                relative = PurePosixPath(name)
                if relative.is_absolute() or ".." in relative.parts or "\\" in name:
                    raise AssertionError("VSIX has an invalid entry path")
            archive.extractall(root)
        extension = root / "extension"
        installed = root / "user" / "runtime" / "current"
        script = (
            "const m=require(process.argv[1]);"
            "process.stdout.write(m.installBundledRuntime(process.argv[2],process.argv[3],process.argv[4]));"
        )
        installed_result = subprocess.run(
            ["node", "-e", script, str(extension / "lib" / "service-manager.js"),
             str(extension / "runtime-bundle"), str(installed),
             vsix.stem.removeprefix("porthole-")],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=60,
        )
        if installed_result.returncode != 0:
            raise AssertionError(installed_result.stderr or installed_result.stdout)
        executable = Path(installed_result.stdout)
        if not executable.is_file():
            raise AssertionError("Bundled installer did not create the runtime executable")
        tunnel_script = (
            "const m=require(process.argv[1]);"
            "m.ensureTunnelClient(process.argv[3],{bundleRoot:process.argv[2],"
            "download:async()=>{throw new Error('offline installer attempted network')}})"
            ".then(p=>process.stdout.write(p)).catch(e=>{console.error(e.message);process.exitCode=1});"
        )
        tunnel_install = subprocess.run(
            ["node", "-e", tunnel_script, str(extension / "lib" / "private-tunnel.js"),
             str(extension / "tunnel-bundle"), str(root / "user" / "tunnel")],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=60,
        )
        if tunnel_install.returncode != 0:
            raise AssertionError(tunnel_install.stderr or tunnel_install.stdout)
        tunnel_executable = Path(tunnel_install.stdout)
        if not tunnel_executable.is_file():
            raise AssertionError("Offline tunnel installer did not create an executable")
        print("Official tunnel client: offline installation from extracted VSIX passed")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("verify_runtime.py")), str(executable),
             "--extension-root", str(extension), "--tunnel-executable", str(tunnel_executable)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=180,
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        print(result.stdout.strip())
        reset = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("verify-reset.py")), str(executable)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=180,
        )
        if reset.returncode != 0:
            raise AssertionError(reset.stdout + reset.stderr)
        print(reset.stdout.strip())
        source_extension = Path(__file__).resolve().parents[1] / "extensions" / "vscode"
        environment = {**os.environ, "PORTHOLE_TEST_EXTENSION_PATH": str(extension)}
        host = subprocess.run(
            ["node", "integration/run.js"], cwd=source_extension, env=environment,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=120,
        )
        if host.returncode != 0:
            raise AssertionError(host.stdout + host.stderr)
        print("VS Code Extension Host: passed using extracted VSIX")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("vsix", type=Path)
    verify(parser.parse_args().vsix.resolve())
