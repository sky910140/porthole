"""Write candidate checksums and reject cross-package version drift."""

from __future__ import annotations

import hashlib
import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3:
        raise SystemExit("usage: candidate_manifest.py WHEEL VSIX RUNTIME_ZIP")
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    extension = json.loads((ROOT / "extensions/vscode/package.json").read_text(encoding="utf-8"))
    runtime = json.loads((ROOT / "artifacts/runtime/runtime-manifest.json").read_text(encoding="utf-8-sig"))
    if len({version, extension["version"], runtime["version"]}) != 1:
        raise ValueError("candidate package versions differ")
    if any(version not in Path(raw).name for raw in args[:2]):
        raise ValueError("candidate wheel or VSIX filename version differs")
    files = []
    for raw in args:
        path = Path(raw).resolve()
        data = path.read_bytes()
        files.append({
            "name": path.name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    packaged_runtime = runtime["artifacts"]["win32-x64"]
    if (packaged_runtime["size"] != files[2]["bytes"]
            or packaged_runtime["sha256"].lower() != files[2]["sha256"]):
        raise ValueError("runtime manifest does not match packaged archive")
    document = {
        "version": version,
        "status": "unpublished-unsigned-candidate",
        "ci_target_host_versions": ["1.137.0", "1.138.0"],
        "artifacts": files,
    }
    target = ROOT / "dist/candidate-manifest.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2), encoding="utf-8")
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
