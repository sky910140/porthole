"""Check packaged credential-vault commands using a disposable identity."""

from __future__ import annotations

import json
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path


def verify(executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="porthole-vault-") as directory:
        root = Path(directory)
        config = root / "config.json"

        def invoke(command: str, *, payload: str | None = None) -> subprocess.CompletedProcess[str]:
            return subprocess.run([str(executable), command, "--config", str(config),
                                   *( ["--project", str(root), "--id", "vault-test"]
                                     if command == "init" else [] )],
                                  input=payload, text=True, capture_output=True,
                                  check=False, timeout=30)

        initialized = invoke("init")
        assert initialized.returncode == 0, initialized.stderr
        client_id = secrets.token_urlsafe(16)
        client_secret = secrets.token_urlsafe(32)
        try:
            stored = invoke("credential-store", payload=json.dumps({
                "client_id": client_id, "client_secret": client_secret,
            }))
            assert stored.returncode == 0, stored.stderr
            assert client_id not in stored.stdout and client_secret not in stored.stdout
            print("Packaged Windows credential-vault store: passed")
        finally:
            cleared = invoke("credential-clear")
            assert cleared.returncode == 0, cleared.stderr


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve())
