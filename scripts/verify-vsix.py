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
    with tempfile.TemporaryDirectory(prefix="ai-zhagan-vsix-") as raw:
        root = Path(raw)
        with ZipFile(vsix) as archive:
            names = archive.namelist()
            if not any(name == "extension/runtime-bundle/bundle.json" for name in names):
                raise AssertionError("VSIX does not contain a runtime manifest")
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
             vsix.stem.removeprefix("ai-zhagan-context-")],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=60,
        )
        if installed_result.returncode != 0:
            raise AssertionError(installed_result.stderr or installed_result.stdout)
        executable = Path(installed_result.stdout)
        if not executable.is_file():
            raise AssertionError("Bundled installer did not create the runtime executable")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("verify_runtime.py")), str(executable)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, timeout=120,
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        print(result.stdout.strip())
        source_extension = Path(__file__).resolve().parents[1] / "extensions" / "vscode"
        environment = {**os.environ, "AI_ZHAGAN_TEST_EXTENSION_PATH": str(extension)}
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
