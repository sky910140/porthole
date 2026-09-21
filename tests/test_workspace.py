from __future__ import annotations

import os
from pathlib import Path

import pytest

from project_mcp.workspace import Workspace


def test_workspace_info_and_file_listing_are_bounded_and_filter_secrets(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / ".env").write_text("TOKEN=secret", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "leak.js").write_text("secret", encoding="utf-8")

    workspace = Workspace(tmp_path, "demo")

    info = workspace.workspace_info()
    listing = workspace.list_files(limit=1)
    assert info["project_id"] == "demo"
    assert info["root"] == "."
    assert listing == {
        "project_id": "demo",
        "path": ".",
        "files": [{"path": "src/app.py", "size": 13}],
        "offset": 0,
        "limit": 1,
        "truncated": False,
    }


@pytest.mark.parametrize(
    "path",
    ["../outside.txt", "/absolute.txt", r"C:\\Windows\\win.ini", "file.txt:stream", "CON"],
)
def test_resolve_file_rejects_traversal_absolute_ads_and_device_paths(
    tmp_path: Path, path: str
) -> None:
    workspace = Workspace(tmp_path, "demo")
    with pytest.raises((ValueError, PermissionError)):
        workspace.resolve_file(path)


def test_resolve_file_rejects_symlink_traversal(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("hidden", encoding="utf-8")
    link = tmp_path / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(PermissionError):
        Workspace(tmp_path, "demo").resolve_file("linked/secret.txt")


def test_read_file_returns_fresh_text_metadata_and_rejects_binary_or_large_files(
    tmp_path: Path,
) -> None:
    source = tmp_path / "hello.py"
    source.write_text("one\ntwo\nthree\n", encoding="utf-8")
    workspace = Workspace(tmp_path, "demo")

    first = workspace.read_file("hello.py", 2, 3)
    source.write_text("changed\ntwo\nthree\n", encoding="utf-8")
    os.utime(source, None)
    second = workspace.read_file("hello.py", 1, 1)

    assert first["lines"] == [{"line": 2, "text": "two"}, {"line": 3, "text": "three"}]
    assert first["sha256"] != second["sha256"]
    assert second["lines"] == [{"line": 1, "text": "changed"}]
    assert isinstance(second["mtime_ns"], int)

    (tmp_path / "binary.bin").write_bytes(b"hello\x00world")
    (tmp_path / "large.txt").write_bytes(b"x" * (1024 * 1024 + 1))
    with pytest.raises(ValueError, match="binary"):
        workspace.read_file("binary.bin")
    with pytest.raises(ValueError, match="too large"):
        workspace.read_file("large.txt")


def test_search_code_is_fixed_string_filtered_and_limited(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("a+b\na+b\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("a.*b\n", encoding="utf-8")
    (tmp_path / "credentials.json").write_text('a+b: "secret"', encoding="utf-8")

    result = Workspace(tmp_path, "demo").search_code("a+b", limit=1)

    assert result["matches"] == [{"path": "a.py", "line": 1, "text": "a+b"}]
    assert result["truncated"] is True
    with pytest.raises(ValueError):
        Workspace(tmp_path, "demo").search_code("")


@pytest.mark.parametrize(
    "path",
    [
        ".local/token.txt",
        ".ssh/id_ed25519",
        ".codex/auth.json",
        ".agents/state.json",
        "config/local.json",
        "tokens.json",
        "server.pem",
        "client.key",
        "certificate.p12",
        "certificate.pfx",
        "nested/my_private_key.txt",
        "nested/config/local.json",
    ],
)
def test_sensitive_paths_are_excluded_from_read_and_search(tmp_path: Path, path: str) -> None:
    target = tmp_path / Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("unique-secret-marker", encoding="utf-8")
    workspace = Workspace(tmp_path, "demo")

    with pytest.raises(PermissionError):
        workspace.read_file(path)
    assert workspace.search_code("unique-secret-marker")["matches"] == []


@pytest.mark.parametrize("path", [".env.", ".env ", "folder./file.txt", "folder /file.txt"])
def test_windows_trailing_dot_or_space_aliases_are_rejected(tmp_path: Path, path: str) -> None:
    with pytest.raises(ValueError):
        Workspace(tmp_path, "demo").resolve_file(path)


def test_list_files_reports_scan_truncation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for index in range(3):
        (tmp_path / f"{index}.txt").write_text(str(index), encoding="utf-8")
    monkeypatch.setattr("project_mcp.workspace.MAX_SCAN_FILES", 2)

    result = Workspace(tmp_path, "demo").list_files(limit=10)

    assert len(result["files"]) == 2
    assert result["truncated"] is True


def test_custom_excluded_paths_are_hidden_from_every_workspace_tool(tmp_path: Path) -> None:
    state_dir = tmp_path / "runtime"
    state_dir.mkdir()
    secret = state_dir / "session.json"
    secret.write_text("custom-runtime-secret", encoding="utf-8")
    config = tmp_path / "assistant.json"
    config.write_text("custom-config-secret", encoding="utf-8")
    workspace = Workspace(tmp_path, "demo", excluded_paths=[state_dir, config])

    assert workspace.list_files()["files"] == []
    assert workspace.search_code("custom-runtime-secret")["matches"] == []
    assert workspace.search_code("custom-config-secret")["matches"] == []
    with pytest.raises(PermissionError):
        workspace.read_file("runtime/session.json")
    with pytest.raises(PermissionError):
        workspace.read_file("assistant.json")
