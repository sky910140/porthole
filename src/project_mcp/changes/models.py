"""Validated wire and persistence models for immutable change proposals."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_CHANGE_FILES = 20
MAX_CHANGE_FILE_BYTES = 1024 * 1024
MAX_CHANGE_REQUEST_BYTES = 2 * 1024 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")

ChangeState = Literal[
    "pending_review", "rejected", "expired", "conflict", "applying",
    "applied", "rolled_back", "recovery_required", "reverting", "reverted",
]


class FileChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=500)
    operation: Literal["create", "modify"]
    base_sha256: str | None = None
    content_utf8: str

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        windows = PureWindowsPath(value)
        posix = PurePosixPath(normalized)
        if (
            "\x00" in value or windows.is_absolute() or windows.drive or posix.is_absolute()
            or any(part in {"", ".", ".."} or part.endswith((" ", ".")) for part in posix.parts)
        ):
            raise ValueError("change path must be a safe relative file path")
        return posix.as_posix()

    @model_validator(mode="after")
    def operation_rules(self):
        size = len(self.content_utf8.encode("utf-8"))
        if size > MAX_CHANGE_FILE_BYTES:
            raise ValueError("FILE_TOO_LARGE: final content exceeds 1 MiB")
        if self.operation == "create" and self.base_sha256 is not None:
            raise ValueError("create base_sha256 must be null")
        if self.operation == "modify" and (
            self.base_sha256 is None or not SHA256.fullmatch(self.base_sha256)
        ):
            raise ValueError("modify requires a lowercase SHA-256 base hash")
        return self


class ChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    request_id: str = Field(min_length=1, max_length=128)
    summary: str = Field(min_length=1, max_length=500)
    files: list[FileChange] = Field(min_length=1, max_length=MAX_CHANGE_FILES)

    @model_validator(mode="after")
    def request_limits(self):
        aliases: set[str] = set()
        for item in self.files:
            alias = item.path.casefold()
            if alias in aliases:
                raise ValueError("duplicate change path")
            aliases.add(alias)
        encoded = json.dumps(
            self.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"),
        ).encode("utf-8")
        if len(encoded) > MAX_CHANGE_REQUEST_BYTES:
            raise ValueError("QUOTA_EXCEEDED: change request exceeds 2 MiB")
        return self


class ChangeResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    change_id: str
    state: ChangeState
    manifest_sha256: str
    revision: int = Field(ge=1)
    blocked_reason: str | None = None
    error_code: str | None = None


def manifest_document(request: ChangeRequest) -> dict:
    return {
        "project_id": request.project_id,
        "request_id": request.request_id,
        "summary": request.summary,
        "files": [{
            "path": item.path,
            "operation": item.operation,
            "base_sha256": item.base_sha256,
            "content_sha256": hashlib.sha256(item.content_utf8.encode("utf-8")).hexdigest(),
        } for item in request.files],
    }


def canonical_sha256(value: dict) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
