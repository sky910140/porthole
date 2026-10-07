"""Independent, expiring health layers and explicit verification challenges."""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

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
        history_path: Path | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.ttl = timedelta(seconds=ttl_seconds)
        self.challenge_ttl = timedelta(seconds=challenge_ttl_seconds)
        self.now = now or (lambda: datetime.now(UTC))
        self._checks = {layer: HealthCheck() for layer in HEALTH_LAYERS}
        self._challenges: dict[str, VerificationChallenge] = {}
        self.history_path = history_path
        self._verified: dict[str, str] = {}
        self._activity: dict[str, str] = {}
        self._current_verified_project: str | None = None
        self._tool_project: str | None = None
        if history_path is not None:
            try:
                raw = json.loads(history_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    for key, value in list(raw.items())[:64]:
                        if isinstance(key, str) and isinstance(value, str):
                            datetime.fromisoformat(value)
                            self._verified[key] = value
            except (OSError, ValueError, TypeError):
                pass

    def verification_history(self) -> dict[str, str]:
        return dict(self._verified)

    def recent_tool_activity(self) -> dict[str, str]:
        return dict(self._activity)

    def current_verified_project_id(self) -> str | None:
        if self.snapshot()["tool_call"]["state"] != "ok":
            return None
        return self._current_verified_project

    def tool_call_project_id(self) -> str | None:
        return self._tool_project if self.snapshot()["tool_call"]["state"] != "unknown" else None

    def clear_project(self, project_id: str) -> None:
        self._verified.pop(project_id, None)
        self._activity.pop(project_id, None)
        if self._current_verified_project == project_id:
            self._current_verified_project = None
        if self._tool_project == project_id:
            self._tool_project = None
            self.record("tool_call", "unknown")
        self._save_history()

    def record_tool_activity(self, project_id: str) -> None:
        self._activity[project_id] = self.now().isoformat()

    def _save_history(self) -> None:
        if self.history_path is None:
            return
        temp = self.history_path.with_name(
            f"{self.history_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        )
        try:
            self.history_path.parent.mkdir(parents=True, exist_ok=True)
            with temp.open("x", encoding="utf-8") as stream:
                json.dump(self._verified, stream)
            temp.replace(self.history_path)
        except OSError:
            temp.unlink(missing_ok=True)

    def record(
        self,
        layer: HealthLayer,
        state: CheckState,
        error_code: ErrorCode | str | None = None,
        retryable: bool = False,
    ) -> None:
        if layer not in HEALTH_LAYERS:
            raise ValueError(f"Unknown health layer: {layer}")
        if layer == "tool_call" and state != "ok":
            self._current_verified_project = None
            if state == "unknown":
                self._tool_project = None
        self._checks[layer] = HealthCheck(
            state=state,
            checked_at=None if state == "unknown" else self.now(),
            error_code=error_code,
            retryable=retryable,
        )

    def snapshot(self) -> dict[str, dict]:
        current = self.now()
        self._challenges = {
            key: challenge for key, challenge in self._challenges.items()
            if current <= challenge.expires_at
        }
        result: dict[str, dict] = {}
        for layer, check in self._checks.items():
            rendered = check
            if layer == "tool_call" and check.state == "checking" and not self._challenges:
                rendered = check.model_copy(update={
                    "state": "expired", "error_code": ErrorCode.LEASE_EXPIRED, "retryable": True,
                })
            if (
                check.checked_at is not None
                and rendered.state not in {"unknown", "expired"}
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
        self._tool_project = project_id
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
            another_active = any(
                item.project_id == project_id and self.now() <= item.expires_at
                for item in self._challenges.values()
            )
            if self._tool_project == project_id and not another_active:
                self.record("tool_call", "expired", ErrorCode.LEASE_EXPIRED, retryable=True)
            return False
        if challenge.project_id != project_id or challenge.expected_tool != tool_name:
            return False
        self._challenges.pop(challenge_id, None)
        if not read_succeeded:
            self._tool_project = project_id
            self.record("tool_call", "failed", ErrorCode.STORAGE_UNAVAILABLE, retryable=True)
            return False
        self.record("tool_call", "ok")
        self._tool_project = project_id
        self._current_verified_project = project_id
        self._verified[project_id] = self.now().isoformat()
        self._save_history()
        return True
