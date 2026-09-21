import os
import subprocess

import pytest

from project_mcp.workspace import Workspace


@pytest.mark.skipif(os.name != "nt", reason="Windows junction boundary")
def test_junction_cannot_read_or_search_outside_workspace(tmp_path):
    root = tmp_path / "project"
    target = tmp_path / "outside"
    root.mkdir()
    target.mkdir()
    (target / "secret.txt").write_text("OUTSIDE_ONLY", encoding="utf8")
    link = root / "linked"
    command = "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null".format(
        str(link).replace("'", "''"), str(target).replace("'", "''"))
    result = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                            capture_output=True, timeout=15, check=False)
    assert result.returncode == 0, result.stderr
    try:
        workspace = Workspace(root, "demo")
        with pytest.raises(PermissionError):
            workspace.read_file("linked/secret.txt")
        assert workspace.search_code("OUTSIDE_ONLY")["matches"] == []
        assert workspace.list_files()["files"] == []
    finally:
        os.rmdir(link)
    assert (target / "secret.txt").read_text() == "OUTSIDE_ONLY"
