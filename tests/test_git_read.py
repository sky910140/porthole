from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from project_mcp.workspace import Workspace


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Test User")
    git(tmp_path, "config", "user.email", "test@example.invalid")
    (tmp_path / "tracked.txt").write_text("base\n", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=base\n", encoding="utf-8")
    git(tmp_path, "add", "tracked.txt", ".env")
    git(tmp_path, "commit", "-qm", "initial")
    return tmp_path


def test_git_status_filters_sensitive_and_untracked_paths(repo: Path) -> None:
    (repo / "tracked.txt").write_text("changed\n", encoding="utf-8")
    (repo / "new.txt").write_text("new\n", encoding="utf-8")
    (repo / ".env").write_text("SECRET=changed\n", encoding="utf-8")
    (repo / ".local").mkdir()
    (repo / ".local" / "token.txt").write_text("TOKEN=hidden\n", encoding="utf-8")

    result = Workspace(repo, "demo").git_status()

    assert result["is_repository"] is True
    assert result["entries"] == [
        {"index": " ", "worktree": "M", "path": "tracked.txt"},
        {"index": "?", "worktree": "?", "path": "new.txt"},
    ]


def test_git_diff_filters_new_sensitive_extensions(repo: Path) -> None:
    secret = repo / "server.pem"
    secret.write_text("private-key-material\n", encoding="utf-8")
    git(repo, "add", "server.pem")

    result = Workspace(repo, "demo").git_diff(staged=True)

    assert result["diff"] == ""
    assert result["excluded"] is True


def test_git_diff_separates_staged_and_unstaged_and_filters_secret_content(repo: Path) -> None:
    (repo / "tracked.txt").write_text("staged\n", encoding="utf-8")
    git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("unstaged\n", encoding="utf-8")
    (repo / ".env").write_text("SECRET=do-not-leak\n", encoding="utf-8")

    workspace = Workspace(repo, "demo")
    staged = workspace.git_diff(staged=True)
    unstaged = workspace.git_diff()

    assert "+staged" in staged["diff"]
    assert "unstaged" not in staged["diff"]
    assert "+unstaged" in unstaged["diff"]
    assert "do-not-leak" not in unstaged["diff"]
    assert ".env" not in unstaged["diff"]


def test_git_diff_rejects_sensitive_staged_rename(repo: Path) -> None:
    git(repo, "mv", "tracked.txt", "credentials.json")

    result = Workspace(repo, "demo").git_diff(staged=True)

    assert result["diff"] == ""
    assert result["excluded"] is True


def test_git_diff_rejects_staged_rename_from_sensitive_path(repo: Path) -> None:
    git(repo, "mv", ".env", "public.txt")

    result = Workspace(repo, "demo").git_diff(staged=True)

    assert result["diff"] == ""
    assert result["excluded"] is True


def test_git_calls_report_non_repository(tmp_path: Path) -> None:
    workspace = Workspace(tmp_path, "demo")
    assert workspace.git_status() == {
        "project_id": "demo",
        "is_repository": False,
        "entries": [],
        "truncated": False,
    }
    assert workspace.git_diff() == {
        "project_id": "demo",
        "is_repository": False,
        "path": ".",
        "staged": False,
        "diff": "",
        "truncated": False,
        "excluded": False,
    }


def test_git_diff_rejects_traversal(repo: Path) -> None:
    with pytest.raises((ValueError, PermissionError)):
        Workspace(repo, "demo").git_diff("../outside")


def test_git_status_and_diff_are_scoped_to_nested_workspace(repo: Path) -> None:
    nested = repo / "nested"
    nested.mkdir()
    (nested / "inside.txt").write_text("base\n", encoding="utf-8")
    (repo / "outside.txt").write_text("base\n", encoding="utf-8")
    git(repo, "add", "nested/inside.txt", "outside.txt")
    git(repo, "commit", "-qm", "nested base")
    (nested / "inside.txt").write_text("inside changed\n", encoding="utf-8")
    (repo / "outside.txt").write_text("outside changed\n", encoding="utf-8")

    workspace = Workspace(nested, "nested")
    status = workspace.git_status()
    diff = workspace.git_diff()

    assert status["entries"] == [{"index": " ", "worktree": "M", "path": "inside.txt"}]
    assert "inside changed" in diff["diff"]
    assert "outside changed" not in diff["diff"]
    assert "../" not in diff["diff"]


def test_git_diff_treats_path_as_literal_pathspec(repo: Path) -> None:
    literal = repo / "wild[ab].txt"
    other = repo / "wilda.txt"
    literal.write_text("base\n", encoding="utf-8")
    other.write_text("base\n", encoding="utf-8")
    git(repo, "add", "wild[ab].txt", "wilda.txt")
    git(repo, "commit", "-qm", "literal path")
    literal.write_text("literal changed\n", encoding="utf-8")
    other.write_text("other changed\n", encoding="utf-8")

    result = Workspace(repo, "demo").git_diff("wild[ab].txt")

    assert "literal changed" in result["diff"]
    assert "other changed" not in result["diff"]


def test_workspace_info_includes_branch_and_head(repo: Path) -> None:
    expected_head = git(repo, "rev-parse", "HEAD").strip()

    result = Workspace(repo, "demo").workspace_info()

    assert result["branch"]
    assert result["head"] == expected_head


def test_git_diff_refuses_partial_name_enumeration(
    monkeypatch: pytest.MonkeyPatch, repo: Path
) -> None:
    for index in range(10):
        path = repo / f"long-file-name-{index:02d}.txt"
        path.write_text("content\n", encoding="utf-8")
        git(repo, "add", path.name)
    monkeypatch.setattr("project_mcp.git_read.MAX_GIT_OUTPUT", 50)

    result = Workspace(repo, "demo").git_diff(staged=True)

    assert result["diff"] == ""
    assert result["truncated"] is True


def test_git_status_marks_bounded_output_as_truncated(
    monkeypatch: pytest.MonkeyPatch, repo: Path
) -> None:
    for index in range(10):
        (repo / f"untracked-long-name-{index:02d}.txt").write_text("content\n", encoding="utf-8")
    monkeypatch.setattr("project_mcp.git_read.MAX_GIT_OUTPUT", 50)

    result = Workspace(repo, "demo").git_status()

    assert result["truncated"] is True
    assert len(str(result)) < 1000


def test_custom_excluded_deleted_paths_are_hidden_from_git(repo: Path) -> None:
    state_dir = repo / "runtime"
    state_dir.mkdir()
    secret = state_dir / "session.json"
    secret.write_text("historical-runtime-secret\n", encoding="utf-8")
    git(repo, "add", "runtime/session.json")
    git(repo, "commit", "-qm", "runtime state")
    secret.unlink()

    workspace = Workspace(repo, "demo", excluded_paths=[state_dir])
    status = workspace.git_status()
    diff = workspace.git_diff()

    assert all(not entry["path"].startswith("runtime/") for entry in status["entries"])
    assert "historical-runtime-secret" not in diff["diff"]
    assert diff["excluded"] is True


def test_narrow_git_diff_filters_both_ends_of_sensitive_rename(repo: Path) -> None:
    git(repo, "mv", ".env", "public.txt")

    workspace = Workspace(repo, "demo")
    narrow = workspace.git_diff("public.txt", staged=True)
    whole = workspace.git_diff(staged=True)

    assert narrow["diff"] == ""
    assert narrow["excluded"] is True
    assert "SECRET" not in whole["diff"]


def test_nested_workspace_omits_rename_from_sensitive_parent(repo: Path) -> None:
    nested = repo / "nested"
    nested.mkdir()
    git(repo, "mv", ".env", "nested/public.txt")

    workspace = Workspace(nested, "nested")
    result = workspace.git_diff("public.txt", staged=True)

    assert result["diff"] == ""
    assert result["excluded"] is True
    assert workspace.git_status()["entries"] == []
