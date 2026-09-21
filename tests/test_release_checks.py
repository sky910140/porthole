from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "check_release_contents.py"


def run_check(tmp_path: Path, names: list[str]) -> subprocess.CompletedProcess[str]:
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("\n".join(names), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(manifest)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_release_manifest_accepts_public_files(tmp_path):
    result = run_check(tmp_path, ["README.md", "src/project_mcp/server.py"])
    assert result.returncode == 0, result.stderr


def test_release_manifest_rejects_local_credentials(tmp_path):
    result = run_check(tmp_path, ["README.md", "config/local.json", ".local/tokens.json"])
    assert result.returncode == 1
    assert "config/local.json" in result.stderr
    assert ".local/tokens.json" in result.stderr
