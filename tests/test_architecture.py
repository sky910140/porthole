from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "check_architecture.py"


def test_domain_module_rejects_http_adapter_import(tmp_path):
    module = tmp_path / "domain.py"
    module.write_text("from fastmcp import FastMCP\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(module)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "fastmcp" in result.stderr


def test_domain_module_accepts_standard_library(tmp_path):
    module = tmp_path / "domain.py"
    module.write_text("from dataclasses import dataclass\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(module)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
