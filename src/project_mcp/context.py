"""Bounded, expiring editor snapshots; no buffers are written to disk."""
from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    text: str = Field(max_length=262144)


class Diagnostic(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line: int = Field(ge=1)
    severity: str = Field(max_length=20)
    message: str = Field(max_length=4096)


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    path: str = Field(min_length=1, max_length=1024)
    version: int = Field(ge=0)
    text: str = Field(max_length=1048576)
    selection: Selection | None = None
    diagnostics: list[Diagnostic] = Field(default_factory=list, max_length=100)


class ContextStore:
    def __init__(self, ttl: float = 900):
        self.ttl = ttl
        self._items: dict[str, tuple[float, dict[str, Any]]] = {}

    def _expire(self):
        now = time.monotonic()
        self._items = {key: value for key, value in self._items.items()
                       if now - value[0] < self.ttl}

    def put(self, workspace, payload: dict) -> dict:
        value = Snapshot.model_validate(payload)
        if value.project_id != workspace.project_id:
            raise ValueError("Project mismatch")
        workspace.resolve_file(value.path)
        if len(value.text.encode("utf8")) > 1048576:
            raise ValueError("Editor snapshot exceeds 1 MiB")
        lines = max(1, len(value.text.split("\n")))
        if value.selection and not (1 <= value.selection.start_line <= value.selection.end_line <= lines):
            raise ValueError("Selection is outside document")
        self._expire()
        previous = self._items.get(value.session_id)
        if previous:
            old = previous[1]
            if old["project_id"] != value.project_id:
                raise ValueError("Session already belongs to another project")
            if old["path"] == value.path and value.version < old["version"]:
                raise ValueError("Stale document version")
        elif len(self._items) >= 16:
            raise ValueError("Too many editor sessions; disconnect an unused session")
        data = value.model_dump()
        data["source"] = "editor_buffer"
        data["captured_at"] = time.time()
        self._items[value.session_id] = (time.monotonic(), data)
        return {"session_id": value.session_id, "version": value.version}

    def get(self, project_id: str, session_id: str) -> dict:
        self._expire()
        value = self._items.get(session_id)
        if not value or value[1]["project_id"] != project_id:
            raise ValueError("Editor session unavailable or expired; publish context again")
        return value[1].copy()

    def list(self, project_id: str | None = None) -> list[dict]:
        self._expire()
        keys = ("project_id", "session_id", "path", "version", "captured_at")
        return [{key: data[key] for key in keys} for _, data in self._items.values()
                if project_id is None or data["project_id"] == project_id]

    def delete(self, session_id: str):
        self._items.pop(session_id, None)
