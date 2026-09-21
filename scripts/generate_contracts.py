"""Generate or check the cross-client protocol schema."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "src"))

from project_mcp.protocol import contract_document

TARGET = ROOT / "contracts" / "generated" / "protocol.schema.json"


def rendered() -> str:
    return json.dumps(contract_document(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    expected = rendered()
    if args.write:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(expected, encoding="utf8")
        print(f"wrote {TARGET.relative_to(ROOT)}")
        return 0
    if not TARGET.is_file() or TARGET.read_text(encoding="utf8") != expected:
        print("generated protocol contract is stale; run scripts/generate_contracts.py --write")
        return 1
    print("generated protocol contract is current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
