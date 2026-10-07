"""Black-box verification for the standalone Windows runtime artifact."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastmcp import Client
from openpyxl import Workbook


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def runtime_env() -> dict[str, str]:
    keep = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
    keep["PATH"] = os.pathsep.join(filter(None, [
        str(Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32"),
        os.environ.get("SYSTEMROOT", r"C:\Windows"),
    ]))
    return keep


def invoke(executable: Path, *args: str, timeout: int = 35) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(executable), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=runtime_env(),
    )


@contextmanager
def temporary_runtime_root():
    root = Path(tempfile.mkdtemp(prefix="porthole-runtime-"))
    try:
        yield root
    finally:
        # The shutdown endpoint closes its socket before the child releases its log handle.
        for attempt in range(40):
            try:
                shutil.rmtree(root)
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.1)


async def verify(executable: Path, extension_root: Path | None = None,
                 tunnel_executable: Path | None = None) -> None:
    with temporary_runtime_root() as root:
        (root / "README.md").write_text("# standalone runtime\n", encoding="utf8")
        (root / "estimate.csv").write_text("item,qty\ncable,2\n", encoding="utf8")
        workbook = Workbook()
        workbook.active.append(["item", "qty"])
        workbook.active.append(["cable", 2])
        workbook.save(root / "estimate.xlsx")
        config = root / "config.json"
        initialized = invoke(executable, "init", "--config", str(config), "--project", str(root), "--id", "standalone")
        assert initialized.returncode == 0, initialized.stderr or initialized.stdout
        value = json.loads(config.read_text(encoding="utf8"))
        value.update(mcp_port=free_port(), admin_port=free_port())
        config.write_text(json.dumps(value), encoding="utf8")
        started = invoke(executable, "start", "--config", str(config))
        try:
            log_path = root / ".local" / "server.log"
            log_text = log_path.read_text(encoding="utf8", errors="replace") if log_path.exists() else ""
            assert started.returncode == 0, (
                f"{started.stderr}{started.stdout}\nserver.log:\n{log_text}"
            )
            pair = invoke(executable, "pair", "--config", str(config))
            assert pair.returncode == 0, pair.stderr or pair.stdout
            issued = json.loads(pair.stdout)
            secrets = json.loads((root / ".local" / "tokens.json").read_text(encoding="utf8"))
            assert all(secret not in pair.stdout for secret in secrets.values())
            async with httpx.AsyncClient(trust_env=False) as http:
                paired = await http.post(
                    f"http://127.0.0.1:{value['admin_port']}/api/pair",
                    json={"pairing_code": issued["pairing_code"]},
                )
                assert paired.status_code == 200, paired.text
                assert paired.json()["admin_token"] == secrets["admin_token"]
                page = await http.get(f"http://127.0.0.1:{value['admin_port']}/")
                assert page.status_code == 200 and "舷窗 Porthole" in page.text
                scope = await http.get(
                    f"http://127.0.0.1:{value['admin_port']}/api/projects/standalone/scope",
                    headers={"Authorization": f"Bearer {secrets['admin_token']}"},
                )
                assert scope.status_code == 200
                details = scope.json()
                assert details["scan_complete"] is True
                assert details["files_truncated"] is False
                assert {"README.md", "estimate.csv", "estimate.xlsx"} <= {
                    item["path"] for item in details["files"]
                }
                assert all(not Path(item["path"]).is_absolute() for item in details["files"])
                print("Packaged scope preview: relative file list and complete scan passed")
            async with Client(
                f"http://127.0.0.1:{value['mcp_port']}/mcp",
                auth=secrets["mcp_token"],
            ) as client:
                result = await client.call_tool(
                    "read_file", {"project_id": "standalone", "path": "README.md"}
                )
                assert "standalone runtime" in str(result.data)
                for filename in ("estimate.csv", "estimate.xlsx"):
                    table = await client.call_tool(
                        "read_table", {"project_id": "standalone", "path": filename}
                    )
                    assert table.data["rows"][1]["cells"] == ["cable", "2"]
            if extension_root and tunnel_executable:
                tunnel = await asyncio.to_thread(
                    subprocess.run,
                    ["node", str(Path(__file__).with_name("verify-tunnel.cjs")),
                     str(tunnel_executable), str(extension_root),
                     str(root / ".local" / "tokens.json"), str(value["mcp_port"]), "standalone"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    check=False, timeout=100,
                )
                assert tunnel.returncode == 0, tunnel.stderr or tunnel.stdout
                print(tunnel.stdout.strip())
                async with httpx.AsyncClient(trust_env=False) as http:
                    status = await http.get(f"http://127.0.0.1:{value['admin_port']}/api/status",
                                            headers={"Authorization": f"Bearer {secrets['admin_token']}"})
                    assert status.json()["health"]["tool_call"]["state"] != "ok"
            print(json.dumps({
                "status": "passed",
                "runtime": str(executable),
                "path_without_python_or_node": runtime_env()["PATH"],
            }))
        finally:
            stopped = invoke(executable, "stop", "--config", str(config))
            assert stopped.returncode == 0, stopped.stderr or stopped.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("--extension-root", type=Path)
    parser.add_argument("--tunnel-executable", type=Path)
    args = parser.parse_args()
    asyncio.run(verify(args.executable.resolve(), args.extension_root, args.tunnel_executable))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
