"""Keep domain and storage modules independent from transport adapters."""

from __future__ import annotations

import ast
import sys
from pathlib import Path

BANNED_ROOTS = {"fastmcp", "starlette", "uvicorn", "vscode"}
DEFAULT_FILES = (
    "src/project_mcp/config.py",
    "src/project_mcp/context.py",
    "src/project_mcp/git_read.py",
    "src/project_mcp/health.py",
    "src/project_mcp/pairing.py",
    "src/project_mcp/workspace.py",
    "src/project_mcp/protocol.py",
    "src/project_mcp/policy.py",
    "src/project_mcp/runtime_limits.py",
    "src/project_mcp/changes/models.py",
    "src/project_mcp/changes/store.py",
    "src/project_mcp/changes/content.py",
    "src/project_mcp/changes/executor.py",
    "src/project_mcp/changes/recovery.py",
)


def imported_roots(source: str) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".", 1)[0])
    return roots


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    paths = [Path(item) for item in args] if args else [Path(item) for item in DEFAULT_FILES]
    failures: list[str] = []
    for path in paths:
        if not path.exists():
            continue
        banned = sorted(imported_roots(path.read_text(encoding="utf-8")) & BANNED_ROOTS)
        if banned:
            failures.append(f"{path}: transport imports are not allowed: {', '.join(banned)}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"architecture check passed for {sum(path.exists() for path in paths)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
