"""Versioned wire models shared by the local service and editor clients."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .changes.models import ChangeRequest, ChangeResult, FileChange

PROTOCOL_VERSION = "1.0.0"
SERVICE_VERSION = "0.4.0"
CAPABILITIES = [
    "layered_health",
    "verification_challenge",
    "bounded_reads",
    "project_policy",
    "batch_reads",
    "scope_preview",
    "change_proposals",
    "local_review_required",
    "editor_readiness_lease",
    "recoverable_local_apply",
]

CheckState = Literal["unknown", "checking", "ok", "failed", "expired"]
HealthLayer = Literal["local_service", "transport", "oauth", "tool_call"]
HEALTH_LAYERS: tuple[HealthLayer, ...] = (
    "local_service",
    "transport",
    "oauth",
    "tool_call",
)


class ErrorCode(StrEnum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    PROJECT_FORBIDDEN = "PROJECT_FORBIDDEN"
    PATH_FORBIDDEN = "PATH_FORBIDDEN"
    RATE_LIMITED = "RATE_LIMITED"
    SCAN_LIMIT = "SCAN_LIMIT"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    FILE_CHANGED = "FILE_CHANGED"
    EDITOR_DIRTY = "EDITOR_DIRTY"
    EDITOR_UNAVAILABLE = "EDITOR_UNAVAILABLE"
    LEASE_EXPIRED = "LEASE_EXPIRED"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    RECOVERY_REQUIRED = "RECOVERY_REQUIRED"
    VERSION_INCOMPATIBLE = "VERSION_INCOMPATIBLE"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE"
    RECORD_UNAVAILABLE = "RECORD_UNAVAILABLE"


class HealthCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: CheckState = "unknown"
    checked_at: datetime | None = None
    error_code: ErrorCode | None = None
    retryable: bool = False


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str = Field(max_length=500)
    retryable: bool
    request_id: str = Field(min_length=1, max_length=128)


class ServiceInfo(BaseModel):
    model_config = ConfigDict(extra="allow")

    protocol_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    service_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    capabilities: list[str]


def service_info() -> ServiceInfo:
    return ServiceInfo(
        protocol_version=PROTOCOL_VERSION,
        service_version=SERVICE_VERSION,
        capabilities=CAPABILITIES,
    )


def require_compatible_protocol(version: str) -> None:
    try:
        major = int(version.split(".", 1)[0])
        expected = int(PROTOCOL_VERSION.split(".", 1)[0])
    except (AttributeError, ValueError) as exc:
        raise ValueError("VERSION_INCOMPATIBLE: invalid protocol version") from exc
    if major != expected:
        raise ValueError(
            f"VERSION_INCOMPATIBLE: expected major {expected}, received {version}"
        )


def contract_document() -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "protocol_version": PROTOCOL_VERSION,
        "models": {
            "ServiceInfo": ServiceInfo.model_json_schema(),
            "HealthCheck": HealthCheck.model_json_schema(),
            "ErrorDetail": ErrorDetail.model_json_schema(),
            "FileChange": FileChange.model_json_schema(),
            "ChangeRequest": ChangeRequest.model_json_schema(),
            "ChangeResult": ChangeResult.model_json_schema(),
        },
    }
