"""Reject private runtime files from wheel and VSIX release manifests."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path, PurePosixPath

FORBIDDEN_NAMES = {"tokens.json", "server.log", "credentials.json"}
FORBIDDEN_PARTS = {".git", ".local", ".venv", ".pytest_cache", ".ruff_cache", "oauth"}


def normalize(raw: str) -> PurePosixPath:
    return PurePosixPath(raw.strip().replace("\\", "/").lstrip("./"))


def is_forbidden(raw: str) -> bool:
    path = normalize(raw)
    lowered = tuple(part.lower() for part in path.parts)
    joined = "/".join(lowered)
    return (
        any(part in FORBIDDEN_PARTS for part in lowered)
        or (lowered and lowered[-1] in FORBIDDEN_NAMES)
        or joined == "config/local.json"
        or joined.endswith("/config/local.json")
        or any(part == ".env" or part.startswith(".env.") for part in lowered)
    )


def entries(source: Path) -> list[str]:
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            return archive.namelist()
    return [line for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: check_release_contents.py ARCHIVE_OR_MANIFEST", file=sys.stderr)
        return 2
    source = Path(args[0])
    if not source.is_file():
        print(f"release input does not exist: {source}", file=sys.stderr)
        return 2
    rejected = sorted(raw for raw in entries(source) if is_forbidden(raw))
    if rejected:
        print("release contains forbidden paths:", file=sys.stderr)
        for raw in rejected:
            print(raw, file=sys.stderr)
        return 1
    print(f"release contents accepted: {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
