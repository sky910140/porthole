from __future__ import annotations

import hashlib
import os
import stat
import time
from collections.abc import Iterable, Iterator
from pathlib import Path, PurePosixPath, PureWindowsPath

from .git_read import GitReader
from .policy import ProjectPolicy, sensitive_path

MAX_FILE_BYTES = 1024 * 1024
MAX_SCAN_FILES = 10_000
MAX_LINE_LENGTH = 4_000
MAX_SEARCH_BYTES = 32 * 1024 * 1024
MAX_SEARCH_SECONDS = 3.0
MAX_BATCH_READ_BYTES = 2 * 1024 * 1024

_DEVICE_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def is_excluded_relative(path: str | PurePosixPath) -> bool:
    return sensitive_path(path)


class Workspace:
    def __init__(
        self,
        root: Path,
        project_id: str,
        excluded_paths: Iterable[str | Path] = (),
        policy: ProjectPolicy | None = None,
    ) -> None:
        root = Path(root)
        if not project_id or not project_id.strip():
            raise ValueError("project_id must not be empty")
        if not root.is_absolute():
            root = root.absolute()
        if not root.is_dir():
            raise ValueError("workspace root must be an existing directory")
        self.root = root.resolve(strict=True)
        self.project_id = project_id
        custom_exclusions: list[PurePosixPath] = []
        for raw_path in excluded_paths:
            configured = Path(raw_path)
            try:
                if configured.is_absolute():
                    relative = configured.resolve(strict=False).relative_to(self.root)
                else:
                    relative = Path(*self._validate_configured_path(str(configured)).parts)
            except (OSError, ValueError):
                continue
            custom_exclusions.append(PurePosixPath(relative.as_posix()))
        self.policy = (policy or ProjectPolicy()).with_additional_exclusions(
            [item.as_posix() for item in custom_exclusions]
        )
        self._git = GitReader(self.root, project_id, self._is_excluded)

    @staticmethod
    def _validate_configured_path(path: str) -> PurePosixPath:
        windows = PureWindowsPath(path)
        posix = PurePosixPath(path.replace("\\", "/"))
        if windows.is_absolute() or windows.drive or posix.is_absolute():
            raise ValueError("configured path must be relative")
        if any(part in {"..", ""} or part.endswith((" ", ".")) for part in posix.parts):
            raise ValueError("invalid configured path")
        return posix

    def _is_excluded(self, path: str | PurePosixPath) -> bool:
        relative = PurePosixPath(str(path).replace("\\", "/"))
        return not self.policy.allows(relative, "read")

    def workspace_info(self) -> dict[str, object]:
        return {"project_id": self.project_id, "root": ".", **self._git.info()}

    def _validate_relative(self, path: str, *, allow_dot: bool) -> PurePosixPath:
        if not isinstance(path, str) or not path or "\x00" in path:
            raise ValueError("path must be a non-empty string")
        if ":" in path:
            raise ValueError("drive and alternate data stream paths are not allowed")
        windows = PureWindowsPath(path)
        posix = PurePosixPath(path.replace("\\", "/"))
        if windows.is_absolute() or windows.drive or posix.is_absolute():
            raise ValueError("absolute paths are not allowed")
        if any(part == ".." for part in posix.parts):
            raise PermissionError("path traversal is not allowed")
        clean_parts = tuple(part for part in posix.parts if part not in ("", "."))
        if not clean_parts:
            if allow_dot:
                return PurePosixPath(".")
            raise ValueError("a file path is required")
        for part in clean_parts:
            if part.endswith((" ", ".")):
                raise ValueError("Windows trailing dots and spaces are not allowed")
            base = part.rstrip(" .").split(".", 1)[0].lower()
            if not part.rstrip(" .") or base in _DEVICE_NAMES:
                raise ValueError("invalid Windows path component")
        relative = PurePosixPath(*clean_parts)
        if self._is_excluded(relative):
            raise PermissionError("path is excluded")
        return relative

    def _resolve(self, path: str, *, allow_dot: bool, require_file: bool = False) -> Path:
        relative = self._validate_relative(path, allow_dot=allow_dot)
        candidate = self.root.joinpath(*relative.parts)
        current = self.root
        for part in relative.parts:
            if part == ".":
                continue
            current = current / part
            if current.exists() or current.is_symlink():
                try:
                    attributes = current.lstat().st_file_attributes
                except AttributeError:
                    attributes = 0
                if current.is_symlink() or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                    raise PermissionError("symbolic link or reparse traversal is not allowed")
        try:
            resolved = candidate.resolve(strict=False)
            resolved.relative_to(self.root)
        except (OSError, ValueError):
            raise PermissionError("path escapes workspace") from None
        if require_file and (not candidate.is_file() or candidate.is_symlink()):
            raise ValueError("path is not a regular file")
        return candidate

    def resolve_file(self, path: str, capability: str = "read") -> Path:
        relative = self._validate_relative(path, allow_dot=False)
        if not self.policy.allows(relative, capability):
            raise PermissionError("path or capability is not allowed")
        return self._resolve(path, allow_dot=False, require_file=True)

    def _iter_files(self, base: Path, depth: int) -> tuple[Iterator[Path], list[bool]]:
        state = [False]

        def walk() -> Iterator[Path]:
            visited = 0
            stack: list[tuple[Path, int]] = [(base, 0)]
            while stack:
                directory, level = stack.pop()
                try:
                    entries = sorted(os.scandir(directory), key=lambda entry: entry.name.lower())
                except (OSError, PermissionError):
                    continue
                for entry in entries:
                    if visited >= MAX_SCAN_FILES:
                        state[0] = True
                        return
                    visited += 1
                    relative = Path(entry.path).relative_to(self.root).as_posix()
                    if self._is_excluded(relative) or entry.is_symlink():
                        continue
                    try:
                        attrs = entry.stat(follow_symlinks=False).st_file_attributes
                    except AttributeError:
                        attrs = 0
                    except OSError:
                        continue
                    if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if level < depth:
                            stack.append((Path(entry.path), level + 1))
                    elif entry.is_file(follow_symlinks=False):
                        yield Path(entry.path)

        return walk(), state

    def list_files(self, path: str = ".", depth: int = 3, limit: int = 200, offset: int = 0) -> dict[str, object]:
        if not isinstance(depth, int) or not 0 <= depth <= 20:
            raise ValueError("depth must be between 0 and 20")
        if not isinstance(limit, int) or not 1 <= limit <= 1000 or not isinstance(offset, int) or offset < 0:
            raise ValueError("invalid pagination")
        base = self._resolve(path, allow_dot=True)
        if not base.is_dir():
            raise ValueError("path is not a directory")
        iterator, scan_truncated = self._iter_files(base, depth)
        files = []
        eligible = 0
        has_more = False
        for file_path in iterator:
            try:
                size = file_path.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_BYTES:
                continue
            if eligible < offset:
                eligible += 1
                continue
            if len(files) >= limit:
                has_more = True
                break
            files.append({"path": file_path.relative_to(self.root).as_posix(), "size": size})
            eligible += 1
        relative = base.relative_to(self.root).as_posix() or "."
        scan_limited = scan_truncated[0]
        reason = "page_limit" if has_more else "scan_limit" if scan_limited else None
        return {
            "project_id": self.project_id,
            "path": relative,
            "files": files,
            "offset": offset,
            "limit": limit,
            "source": "disk",
            "has_more": has_more,
            "next_offset": offset + len(files) if has_more else None,
            "truncation_reason": reason,
            "truncated": has_more or scan_limited,
        }

    @staticmethod
    def _read_text(file_path: Path) -> tuple[str, os.stat_result]:
        info = file_path.stat()
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError("file is too large")
        with file_path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("file is too large")
        if b"\x00" in data:
            raise ValueError("binary file is not supported")
        try:
            return data.decode("utf-8"), info
        except UnicodeDecodeError:
            raise ValueError("binary or non-UTF-8 file is not supported") from None

    def read_file(self, path: str, start_line: int = 1, end_line: int = 200) -> dict[str, object]:
        if not isinstance(start_line, int) or not isinstance(end_line, int) or start_line < 1 or end_line < start_line or end_line - start_line >= 1000:
            raise ValueError("invalid line range")
        file_path = self.resolve_file(path)
        text, info = self._read_text(file_path)
        all_lines = text.splitlines()
        lines = [{"line": number, "text": all_lines[number - 1][:MAX_LINE_LENGTH]} for number in range(start_line, min(end_line, len(all_lines)) + 1)]
        line_range_limited = end_line < len(all_lines)
        line_length_limited = any(
            len(line) > MAX_LINE_LENGTH for line in all_lines[start_line - 1 : end_line]
        )
        reason = "line_range" if line_range_limited else "line_length" if line_length_limited else None
        return {
            "project_id": self.project_id,
            "path": file_path.relative_to(self.root).as_posix(),
            "start_line": start_line,
            "end_line": end_line,
            "total_lines": len(all_lines),
            "lines": lines,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "mtime_ns": info.st_mtime_ns,
            "source": "disk",
            "has_more": line_range_limited,
            "truncation_reason": reason,
            "truncated": line_range_limited or line_length_limited,
        }

    def read_files(self, requests: list[dict]) -> dict[str, object]:
        if not isinstance(requests, list) or not 1 <= len(requests) <= 10:
            raise ValueError("requests must contain 1 to 10 entries")
        results: list[dict[str, object]] = []
        used = 0
        for request in requests:
            if used >= MAX_BATCH_READ_BYTES:
                results.append({
                    "ok": False,
                    "error": {"code": "QUOTA_EXCEEDED", "message": "batch byte budget exhausted"},
                })
                continue
            try:
                if not isinstance(request, dict):
                    raise TypeError("request must be an object")
                value = self.read_file(
                    request.get("path", ""),
                    request.get("start_line", 1),
                    request.get("end_line", 200),
                )
                size = sum(len(item["text"].encode("utf8")) for item in value["lines"])
                if used + size > MAX_BATCH_READ_BYTES:
                    results.append({
                        "ok": False,
                        "error": {"code": "QUOTA_EXCEEDED", "message": "batch byte budget exhausted"},
                    })
                    used = MAX_BATCH_READ_BYTES
                    continue
                used += size
                results.append({"ok": True, "value": value})
            except (TypeError, ValueError, PermissionError, FileNotFoundError) as exc:
                code = "FILE_TOO_LARGE" if "too large" in str(exc) else "PATH_FORBIDDEN"
                results.append({"ok": False, "error": {"code": code, "message": str(exc)}})
        return {
            "project_id": self.project_id,
            "source": "disk",
            "results": results,
            "bytes_returned": used,
            "byte_limit": MAX_BATCH_READ_BYTES,
        }

    def search_code(self, query: str, path: str = ".", limit: int = 50) -> dict[str, object]:
        if not isinstance(query, str) or not query or len(query) > 500 or "\x00" in query:
            raise ValueError("query must contain 1 to 500 characters")
        if not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
        base = self._resolve(path, allow_dot=True)
        if not base.is_dir():
            raise ValueError("path is not a directory")
        iterator, scan_truncated = self._iter_files(base, 20)
        matches: list[dict[str, object]] = []
        has_more = False
        bytes_scanned = 0
        deadline = time.monotonic() + MAX_SEARCH_SECONDS
        for file_path in iterator:
            if time.monotonic() >= deadline:
                has_more = True
                break
            try:
                size = file_path.stat().st_size
                if bytes_scanned + size > MAX_SEARCH_BYTES:
                    has_more = True
                    break
                text, _ = self._read_text(file_path)
                bytes_scanned += size
            except (OSError, ValueError):
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if query in line:
                    if len(matches) >= limit:
                        has_more = True
                        break
                    matches.append({"path": file_path.relative_to(self.root).as_posix(), "line": number, "text": line[:MAX_LINE_LENGTH]})
            if has_more:
                break
        scan_limited = scan_truncated[0]
        reason = "result_limit" if has_more else "scan_limit" if scan_limited else None
        return {
            "project_id": self.project_id,
            "query": query,
            "path": base.relative_to(self.root).as_posix() or ".",
            "matches": matches,
            "limit": limit,
            "source": "disk",
            "has_more": has_more,
            "truncation_reason": reason,
            "truncated": has_more or scan_limited,
        }

    def preview_scope(self) -> dict[str, object]:
        accessible = 0
        scanned = 0
        complete = True
        excluded: dict[str, int] = {}
        stack = [self.root]
        while stack:
            directory = stack.pop()
            try:
                entries = list(os.scandir(directory))
            except (OSError, PermissionError):
                excluded["unavailable"] = excluded.get("unavailable", 0) + 1
                continue
            for entry in entries:
                if scanned >= MAX_SCAN_FILES:
                    complete = False
                    stack.clear()
                    break
                scanned += 1
                relative = Path(entry.path).relative_to(self.root).as_posix()
                reason = self.policy.exclusion_reason(relative)
                if entry.is_symlink():
                    reason = "link_or_reparse"
                else:
                    try:
                        attrs = entry.stat(follow_symlinks=False).st_file_attributes
                    except AttributeError:
                        attrs = 0
                    except OSError:
                        reason = "unavailable"
                        attrs = 0
                    if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                        reason = "link_or_reparse"
                if reason:
                    excluded[reason] = excluded.get(reason, 0) + 1
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    try:
                        if entry.stat(follow_symlinks=False).st_size > MAX_FILE_BYTES:
                            excluded["file_too_large"] = excluded.get("file_too_large", 0) + 1
                        else:
                            accessible += 1
                    except OSError:
                        excluded["unavailable"] = excluded.get("unavailable", 0) + 1
        return {
            "project_id": self.project_id,
            "policy_version": self.policy.version,
            "accessible_files": accessible,
            "excluded_by_reason": excluded,
            "entries_scanned": scanned,
            "scan_complete": complete,
            "truncation_reason": None if complete else "scan_limit",
        }

    def git_status(self) -> dict[str, object]:
        return self._git.status()

    def git_diff(self, path: str = ".", staged: bool = False) -> dict[str, object]:
        relative = self._validate_relative(path, allow_dot=True)
        self._resolve(path, allow_dot=True)
        return self._git.diff(relative.as_posix(), staged)
