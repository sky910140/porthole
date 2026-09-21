"""Independent, expiring health layers and explicit verification challenges."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .protocol import HEALTH_LAYERS, CheckState, ErrorCode, HealthCheck, HealthLayer


@dataclass(frozen=True)
class VerificationChallenge:
    challenge_id: str
    project_id: str
    expected_tool: str
    expires_at: datetime


class HealthRegistry:
    def __init__(
        self,
        *,
        ttl_seconds: int = 300,
        challenge_ttl_seconds: int = 120,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.ttl = timedelta(seconds=ttl_seconds)
        self.challenge_ttl = timedelta(seconds=challenge_ttl_seconds)
        self.now = now or (lambda: datetime.now(UTC))
        self._checks = {layer: HealthCheck() for layer in HEALTH_LAYERS}
        self._challenges: dict[str, VerificationChallenge] = {}

    def record(
        self,
        layer: HealthLayer,
        state: CheckState,
        error_code: ErrorCode | str | None = None,
        retryable: bool = False,
    ) -> None:
        if layer not in HEALTH_LAYERS:
            raise ValueError(f"Unknown health layer: {layer}")
        self._checks[layer] = HealthCheck(
            state=state,
            checked_at=None if state == "unknown" else self.now(),
            error_code=error_code,
            retryable=retryable,
        )

    def snapshot(self) -> dict[str, dict]:
        current = self.now()
        result: dict[str, dict] = {}
        for layer, check in self._checks.items():
            rendered = check
            if (
                check.checked_at is not None
                and check.state not in {"unknown", "expired"}
                and current - check.checked_at > self.ttl
            ):
                rendered = check.model_copy(update={"state": "expired"})
            result[layer] = rendered.model_dump(mode="json")
        return result

    def create_challenge(
        self, project_id: str, *, expected_tool: str = "verify_connection"
    ) -> dict:
        if expected_tool != "verify_connection":
            raise ValueError("Unsupported verification tool")
        challenge = VerificationChallenge(
            challenge_id=secrets.token_urlsafe(24),
            project_id=project_id,
            expected_tool=expected_tool,
            expires_at=self.now() + self.challenge_ttl,
        )
        self._challenges[challenge.challenge_id] = challenge
        self.record("tool_call", "checking")
        return {
            "challenge_id": challenge.challenge_id,
            "project_id": project_id,
            "expected_tool": expected_tool,
            "expires_at": challenge.expires_at.isoformat(),
        }

    def complete_challenge(
        self,
        challenge_id: str,
        project_id: str,
        tool_name: str,
        *,
        read_succeeded: bool,
    ) -> bool:
        challenge = self._challenges.get(challenge_id)
        if challenge is None:
            return False
        if self.now() > challenge.expires_at:
            self._challenges.pop(challenge_id, None)
            self.record("tool_call", "expired", ErrorCode.LEASE_EXPIRED, retryable=True)
            return False
        if challenge.project_id != project_id or challenge.expected_tool != tool_name:
            return False
        self._challenges.pop(challenge_id, None)
        if not read_succeeded:
            self.record("tool_call", "failed", ErrorCode.STORAGE_UNAVAILABLE, retryable=True)
            return False
        self.record("tool_call", "ok")
        return True
