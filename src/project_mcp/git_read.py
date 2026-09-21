from __future__ import annotations

import os
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MAX_GIT_OUTPUT = 512 * 1024
MAX_GIT_ENTRIES = 1000


@dataclass(frozen=True)
class GitResult:
    returncode: int
    stdout: bytes
    truncated: bool = False


class GitReader:
    def __init__(self, root: Path, project_id: str, is_excluded: Callable[[str], bool]) -> None:
        self.root = root
        self.project_id = project_id
        self._is_excluded = is_excluded

    def _run(self, args: list[str], *, max_output: int | None = None) -> GitResult:
        if max_output is None:
            max_output = MAX_GIT_OUTPUT
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
        null_device = "NUL" if os.name == "nt" else "/dev/null"
        env.update({
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_EXTERNAL_DIFF": "",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_LITERAL_PATHSPECS": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": null_device,
        })
        command = [
            "git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL" if os.name == "nt" else "core.hooksPath=/dev/null",
            "-c", "diff.external=", "-c", "diff.trustExitCode=false", "-c", "core.autocrlf=false", *args,
        ]
        try:
            process = subprocess.Popen(
                command,
                cwd=self.root,
                env=env,
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise RuntimeError("git command failed") from exc
        chunks: list[bytes] = []
        total = 0
        truncated = False

        def read_output() -> None:
            nonlocal total, truncated
            assert process.stdout is not None
            while True:
                chunk = process.stdout.read(min(64 * 1024, max_output + 1 - total))
                if not chunk:
                    return
                chunks.append(chunk)
                total += len(chunk)
                if total > max_output:
                    truncated = True
                    process.kill()
                    return

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            reader.join(timeout=1)
            raise RuntimeError("git command timed out") from exc
        reader.join(timeout=1)
        stdout = b"".join(chunks)[:max_output]
        return GitResult(process.returncode, stdout, truncated)

    def is_repository(self) -> bool:
        result = self._run(["rev-parse", "--is-inside-work-tree"])
        return result.returncode == 0 and result.stdout.strip() == b"true"

    def info(self) -> dict[str, object]:
        if not self.is_repository():
            return {"is_repository": False, "branch": None, "head": None}
        head = self._run(["rev-parse", "--verify", "HEAD"])
        branch = self._run(["symbolic-ref", "--quiet", "--short", "HEAD"])
        return {
            "is_repository": True,
            "branch": branch.stdout.decode("utf-8", "replace").strip() if branch.returncode == 0 else None,
            "head": head.stdout.decode("ascii", "replace").strip() if head.returncode == 0 else None,
        }

    def _repo_prefix(self) -> str:
        result = self._run(["rev-parse", "--show-toplevel"], max_output=4096)
        if result.returncode != 0 or result.truncated:
            raise RuntimeError("git repository root unavailable")
        try:
            top = Path(result.stdout.decode("utf-8", "strict").strip()).resolve(strict=True)
            return self.root.relative_to(top).as_posix()
        except (UnicodeDecodeError, OSError, ValueError):
            raise RuntimeError("workspace is outside git repository") from None

    def _workspace_path(self, path: str, prefix: str) -> str | None:
        clean = PurePosixPath(path).as_posix()
        if clean.startswith("../") or clean == ".." or PurePosixPath(clean).is_absolute():
            return None
        if prefix == ".":
            return clean
        marker = f"{prefix}/"
        return clean[len(marker) :] if clean.startswith(marker) else None

    def _excluded(self, path: str) -> bool:
        return self._is_excluded(path)

    def status(self) -> dict[str, object]:
        if not self.is_repository():
            return {"project_id": self.project_id, "is_repository": False, "entries": [], "truncated": False}
        result = self._run(["-c", "status.relativePaths=true", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
        if result.returncode != 0 and not result.truncated:
            raise RuntimeError("git status failed")
        fields = result.stdout.decode("utf-8", "replace").split("\0")
        if result.truncated and result.stdout and not result.stdout.endswith(b"\0"):
            fields[-1] = ""
        entries: list[dict[str, str]] = []
        prefix = self._repo_prefix()
        index = 0
        while index < len(fields) and fields[index]:
            record = fields[index]
            code, path = record[:2], record[3:]
            index += 1
            old_path = None
            if code[0] in "RC" or code[1] in "RC":
                old_path = fields[index] if index < len(fields) else ""
                index += 1
            path = self._workspace_path(path, prefix)
            old_path = self._workspace_path(old_path, prefix) if old_path else None
            if path is None or (old_path is None and (code[0] in "RC" or code[1] in "RC")):
                continue
            if self._excluded(path) or (old_path and self._excluded(old_path)):
                continue
            entry = {"index": code[0], "worktree": code[1], "path": path}
            if old_path:
                entry["original_path"] = old_path
            entries.append(entry)
            if len(entries) >= MAX_GIT_ENTRIES:
                break
        unsafe_paths: set[str] = set()
        changes_truncated = False
        for staged in (False, True):
            _, _, truncated, unsafe = self._changed_paths(".", staged)
            unsafe_paths.update(unsafe)
            changes_truncated = changes_truncated or truncated
        if changes_truncated:
            entries = []
        else:
            entries = [entry for entry in entries if entry["path"] not in unsafe_paths]
        return {
            "project_id": self.project_id,
            "is_repository": True,
            "entries": entries,
            "truncated": len(entries) >= MAX_GIT_ENTRIES or result.truncated or changes_truncated,
        }

    def _changed_paths(
        self, path: str, staged: bool
    ) -> tuple[list[str], bool, bool, set[str]]:
        # Enumerate the repository-wide change records first. Applying the caller's
        # pathspec here can turn a rename into an apparent addition and hide its
        # sensitive source path.
        args = [
            "diff",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
        ]
        if staged:
            args.append("--cached")
        result = self._run(args)
        if result.truncated:
            return [], False, True, set()
        if result.returncode != 0:
            raise RuntimeError("git diff failed")
        fields = result.stdout.decode("utf-8", "replace").split("\0")
        safe: list[str] = []
        unsafe: set[str] = set()
        excluded = False
        prefix = self._repo_prefix()

        def requested(local_path: str) -> bool:
            if path == ".":
                return True
            return local_path == path or local_path.startswith(f"{path}/")

        index = 0
        while index < len(fields) and fields[index]:
            status = fields[index]
            index += 1
            count = 2 if status.startswith(("R", "C")) else 1
            paths = fields[index : index + count]
            index += count
            if len(paths) != count:
                raise RuntimeError("git returned malformed path data")
            local_paths = [self._workspace_path(item, prefix) for item in paths]
            selected = [item for item in local_paths if item is not None and requested(item)]
            if not selected:
                continue
            # A rename/copy crossing the workspace boundary is omitted because
            # its outside endpoint cannot safely be returned to the caller.
            crosses_boundary = count == 2 and any(item is None for item in local_paths)
            sensitive = any(self._excluded(item) for item in paths) or any(
                self._excluded(item) for item in local_paths if item is not None
            )
            if crosses_boundary or sensitive:
                excluded = True
                unsafe.update(selected)
                continue
            safe.extend(item for item in local_paths if item is not None)
        return list(dict.fromkeys(safe)), excluded, False, unsafe

    def diff(self, path: str, staged: bool) -> dict[str, object]:
        response = {"project_id": self.project_id, "is_repository": False, "path": path, "staged": bool(staged), "diff": "", "truncated": False, "excluded": False}
        if not self.is_repository():
            return response
        response["is_repository"] = True
        safe, excluded, names_truncated, _ = self._changed_paths(path, bool(staged))
        response["excluded"] = excluded
        if names_truncated:
            response["truncated"] = True
            return response
        if not safe:
            return response
        args = ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3"]
        if staged:
            args.append("--cached")
        args.extend(["--", *safe])
        result = self._run(args)
        if result.returncode != 0 and not result.truncated:
            raise RuntimeError("git diff failed")
        response["diff"] = result.stdout.decode("utf-8", "replace")
        response["truncated"] = result.truncated
        return response
