"""Throwaway feasibility probe for journaled local-file replacement.

This runs only against a temporary directory. It is evidence for the write-path
decision, not production implementation.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def observe(path: Path, before: bytes, after: bytes) -> str:
    current = path.read_bytes()
    if current == before:
        return "before"
    if current == after:
        return "after"
    return "unknown"


def replace_once(root: Path, crash_point: str) -> dict[str, str]:
    target = root / "target.txt"
    replacement = root / "target.txt.pending"
    journal = root / "transaction.json"
    before = b"before\r\n"
    after = b"after\r\n"
    target.write_bytes(before)
    replacement.write_bytes(after)
    journal.write_text(
        json.dumps({"before": digest(before), "after": digest(after), "phase": "prepared"}),
        encoding="utf-8",
    )
    if crash_point == "prepared":
        return {"phase": crash_point, "observed": observe(target, before, after)}
    os.replace(replacement, target)
    if crash_point == "replaced":
        return {"phase": crash_point, "observed": observe(target, before, after)}
    journal.write_text(
        json.dumps({"before": digest(before), "after": digest(after), "phase": "complete"}),
        encoding="utf-8",
    )
    return {"phase": "complete", "observed": observe(target, before, after)}


def main() -> int:
    results = []
    with tempfile.TemporaryDirectory(prefix="porthole-write-probe-") as raw:
        base = Path(raw)
        for crash_point in ("prepared", "replaced", "complete"):
            case = base / crash_point
            case.mkdir()
            results.append(replace_once(case, crash_point))
    expected = [
        {"phase": "prepared", "observed": "before"},
        {"phase": "replaced", "observed": "after"},
        {"phase": "complete", "observed": "after"},
    ]
    print(json.dumps({"results": results, "expected": expected}, ensure_ascii=False, indent=2))
    return 0 if results == expected else 1


if __name__ == "__main__":
    raise SystemExit(main())
