from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from fastmcp import Client

from project_mcp.config import load_config


async def run(args):
    settings = load_config(args.config)
    async with Client(
        f"http://127.0.0.1:{settings.mcp_port}/mcp", auth=settings.mcp_token,
    ) as client:
        if args.command == "propose":
            result = await client.call_tool("propose_changes", {
                "project_id": "demo",
                "request_id": "e2e-request-1",
                "summary": "E2E update",
                "files": [{
                    "path": "app.txt",
                    "operation": "modify",
                    "base_sha256": hashlib.sha256(b"before\n").hexdigest(),
                    "content_utf8": "after\n",
                }],
            })
        else:
            result = await client.call_tool("get_change_status", {
                "project_id": "demo", "change_id": args.change_id,
            })
        print(json.dumps(result.data))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["propose", "query"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--change-id")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
