"""Bounded structured diagnostics that never accept source text or credentials."""

from __future__ import annotations

import json
import os
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EventType = Literal[
    "change_submit", "change_query", "change_apply", "change_reject",
    "change_revert", "change_recovery", "connection_check", "service_lifecycle",
]
LayerState = Literal["unknown", "checking", "ok", "failed", "expired"]


class DiagnosticEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_type: EventType
    request_id: str | None = Field(default=None, max_length=128)
    change_id: str | None = Field(default=None, max_length=100)
    error_code: str | None = Field(default=None, max_length=64)
    duration_ms: int = Field(ge=0, le=86_400_000)
    health: dict[str, LayerState] = Field(default_factory=dict, max_length=8)

    @field_validator("request_id", "change_id", "error_code")
    @classmethod
    def safe_identifier(cls, value: str | None) -> str | None:
        if value is not None and any(
            not (character.isalnum() or character in "-_.:") for character in value
        ):
            raise ValueError("diagnostic identifiers contain unsupported characters")
        return value

    @field_validator("health")
    @classmethod
    def known_health_layers(cls, value):
        allowed = {"local_service", "transport", "oauth", "tool_call", "change_storage"}
        if set(value) - allowed:
            raise ValueError("unknown health layer")
        return value


class Diagnostics:
    def __init__(
        self,
        directory: Path,
        *,
        max_log_bytes: int = 1024 * 1024,
        max_log_files: int = 5,
        retention_days: int = 7,
        details_provider=None,
        now=None,
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.log_path = self.directory / "events.jsonl"
        self.max_log_bytes = max_log_bytes
        self.max_log_files = max_log_files
        self.retention_seconds = retention_days * 86_400
        self.details_provider = details_provider or dict
        self.now = now or (lambda: datetime.now(UTC))

    def _purge_old(self) -> None:
        cutoff = time.time() - self.retention_seconds
        for path in self.directory.glob("events*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue

    def _rotate(self, incoming: int) -> None:
        if not self.log_path.exists() or self.log_path.stat().st_size + incoming <= self.max_log_bytes:
            return
        oldest = self.directory / f"events.{self.max_log_files - 1}.jsonl"
        oldest.unlink(missing_ok=True)
        for index in range(self.max_log_files - 2, 0, -1):
            source = self.directory / f"events.{index}.jsonl"
            if source.exists():
                os.replace(source, self.directory / f"events.{index + 1}.jsonl")
        os.replace(self.log_path, self.directory / "events.1.jsonl")

    def record_event(self, event: DiagnosticEvent | dict) -> dict:
        value = event if isinstance(event, DiagnosticEvent) else DiagnosticEvent.model_validate(event)
        rendered = {
            "recorded_at": self.now().astimezone(UTC).isoformat(),
            **value.model_dump(mode="json"),
        }
        encoded = (json.dumps(
            rendered, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
        ) + "\n").encode("utf-8")
        self._purge_old()
        self._rotate(len(encoded))
        with self.log_path.open("ab") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        return rendered

    def events(self, *, limit: int = 200) -> list[dict]:
        if not 1 <= limit <= 1000:
            raise ValueError("diagnostic event limit must be between 1 and 1000")
        paths = sorted(
            self.directory.glob("events*.jsonl"),
            key=lambda path: path.stat().st_mtime,
        )
        values = []
        for path in paths:
            try:
                for line in path.read_text(encoding="utf-8").splitlines():
                    values.append(json.loads(line))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
        return values[-limit:]

    @staticmethod
    def _safe_details(value: dict, *, include_paths: bool) -> dict:
        result: dict = {}
        if isinstance(value.get("service"), dict):
            result["service"] = {
                key: item for key, item in value["service"].items()
                if key in {"service_version", "protocol_version", "capabilities"}
            }
        if isinstance(value.get("health"), dict):
            result["health"] = value["health"]
        projects = value.get("projects")
        if isinstance(projects, list):
            if include_paths:
                result["projects"] = [{
                    key: item[key] for key in ("id", "root") if key in item
                } for item in projects if isinstance(item, dict)]
            else:
                result["project_count"] = len(projects)
        return result

    def preview_export(self, *, include_paths: bool = False) -> dict:
        return {
            "included": ["service versions", "layered health", "recent structured activity"],
            "excluded": ["tokens", "source contents", "OAuth responses", "user identities"],
            "path_policy": "included by explicit request" if include_paths else "redacted",
            "event_count": len(self.events()),
        }

    def export_diagnostics(self, destination: Path, *, include_paths: bool = False) -> Path:
        target = Path(destination)
        if target.exists():
            raise FileExistsError(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        document = {
            "schema_version": 1,
            "generated_at": self.now().astimezone(UTC).isoformat(),
            "privacy": {
                "paths_included": include_paths,
                "tokens_included": False,
                "source_contents_included": False,
                "oauth_responses_included": False,
                "user_identities_included": False,
            },
            "details": self._safe_details(
                self.details_provider() or {}, include_paths=include_paths,
            ),
            "events": self.events(),
        }
        payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("diagnostics.json", payload)
        return target
