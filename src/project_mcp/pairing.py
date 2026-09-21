"""Short-lived, single-use pairing codes stored as hashes in user-local state."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path


class PairingStore:
    def __init__(
        self,
        state_dir: Path,
        *,
        ttl_seconds: int = 120,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.state_dir = Path(state_dir).resolve()
        self.path = self.state_dir / "pairing.json"
        self.ttl = timedelta(seconds=ttl_seconds)
        self.now = now or (lambda: datetime.now(UTC))

    @staticmethod
    def _digest(code: str) -> str:
        return hashlib.sha256(code.encode("utf8")).hexdigest()

    def issue(self) -> dict[str, str]:
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        code = secrets.token_urlsafe(32)
        expires_at = self.now() + self.ttl
        payload = {"code_sha256": self._digest(code), "expires_at": expires_at.isoformat()}
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload), encoding="utf8")
        os.chmod(temp, 0o600)
        temp.replace(self.path)
        return {"pairing_code": code, "expires_at": expires_at.isoformat()}

    def consume(self, code: str) -> bool:
        expired = False
        malformed = False
        try:
            payload = json.loads(self.path.read_text(encoding="utf8"))
            expires_at = datetime.fromisoformat(payload["expires_at"])
            expired = self.now() > expires_at
            valid = not expired and hmac.compare_digest(
                payload["code_sha256"], self._digest(code)
            )
        except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            valid = False
            malformed = True
        if self.path.exists() and (valid or expired or malformed):
            self.path.unlink(missing_ok=True)
        return valid
