"""Short-lived cooperative leases for VS Code reviewed file changes."""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath

from pydantic import BaseModel, ConfigDict, Field, field_validator

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ReadinessBlocked(RuntimeError):
    def __init__(self, error_code: str, message: str):
        self.error_code = error_code
        self.message = message
        super().__init__(f"{error_code}: {message}")


class ReviewDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=500)
    version: int = Field(ge=0)
    dirty: bool

    @field_validator("path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        windows = PureWindowsPath(value)
        posix = PurePosixPath(value.replace("\\", "/"))
        if (
            windows.is_absolute() or windows.drive or posix.is_absolute()
            or any(part in {"", ".", ".."} for part in posix.parts)
        ):
            raise ValueError("document path must be relative")
        return posix.as_posix()


class ActiveReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    change_id: str = Field(min_length=1, max_length=100)
    manifest_sha256: str

    @field_validator("manifest_sha256")
    @classmethod
    def valid_hash(cls, value: str) -> str:
        if not _SHA256.fullmatch(value):
            raise ValueError("invalid manifest hash")
        return value


class ReadinessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    documents: list[ReviewDocument] = Field(default_factory=list, max_length=200)
    active_review: ActiveReview | None = None


@dataclass
class _Session:
    project_id: str
    documents: dict[str, ReviewDocument]
    active_review: ActiveReview | None
    revision: int
    seen_at: float


@dataclass
class _Lease:
    lease_id: str
    project_id: str
    change_id: str
    review_session_id: str
    manifest_sha256: str
    paths: tuple[str, ...]
    session_revisions: dict[str, int]
    expires_at: float


class EditorReadiness:
    def __init__(
        self,
        *,
        now=None,
        session_ttl_seconds: float = 10,
        lease_ttl_seconds: float = 5,
    ) -> None:
        if not 0 < lease_ttl_seconds <= 5:
            raise ValueError("readiness lease cannot exceed 5 seconds")
        self.now = now or time.monotonic
        self.session_ttl = session_ttl_seconds
        self.lease_ttl = lease_ttl_seconds
        self._sessions: dict[str, _Session] = {}
        self._leases: dict[str, _Lease] = {}

    def update(self, session_id: str, payload: ReadinessUpdate | dict) -> dict:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 80:
            raise ValueError("invalid editor readiness session id")
        value = payload if isinstance(payload, ReadinessUpdate) else ReadinessUpdate.model_validate(payload)
        previous = self._sessions.get(session_id)
        if previous is None and len(self._sessions) >= 64:
            raise ValueError("too many editor readiness sessions")
        if previous and previous.project_id != value.project_id:
            raise ValueError("editor session cannot be rebound to another project")
        revision = 1 if previous is None else previous.revision + 1
        documents = {item.path.casefold(): item for item in value.documents}
        if len(documents) != len(value.documents):
            raise ValueError("duplicate document path")
        self._sessions[session_id] = _Session(
            project_id=value.project_id,
            documents=documents,
            active_review=value.active_review,
            revision=revision,
            seen_at=self.now(),
        )
        return {"session_id": session_id, "revision": revision}

    def delete(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def list(self, project_id: str | None = None) -> list[dict]:
        current = self.now()
        return [{
            "session_id": session_id,
            "project_id": session.project_id,
            "revision": session.revision,
            "online": current - session.seen_at <= self.session_ttl,
            "active_change_id": (
                session.active_review.change_id if session.active_review else None
            ),
        } for session_id, session in self._sessions.items()
        if project_id is None or session.project_id == project_id]

    def _evaluate(
        self,
        project_id: str,
        change_id: str,
        review_session_id: str,
        manifest_sha256: str,
        paths: list[str] | tuple[str, ...],
    ) -> dict[str, int]:
        now = self.now()
        normalized = {PurePosixPath(path).as_posix().casefold() for path in paths}
        primary = self._sessions.get(review_session_id)
        if (
            primary is None or primary.project_id != project_id
            or now - primary.seen_at > self.session_ttl
            or primary.active_review is None
            or primary.active_review.change_id != change_id
            or primary.active_review.manifest_sha256 != manifest_sha256
        ):
            raise ReadinessBlocked(
                "EDITOR_UNAVAILABLE", "review session is missing, stale, or bound to other content",
            )
        participating: dict[str, int] = {review_session_id: primary.revision}
        dirty: list[str] = []
        unavailable: list[str] = []
        for session_id, session in self._sessions.items():
            if session.project_id != project_id:
                continue
            relevant = [
                document for key, document in session.documents.items() if key in normalized
            ]
            if not relevant:
                continue
            participating[session_id] = session.revision
            if now - session.seen_at > self.session_ttl:
                unavailable.append(session_id)
            dirty.extend(document.path for document in relevant if document.dirty)
        if unavailable:
            raise ReadinessBlocked(
                "EDITOR_UNAVAILABLE",
                f"relevant editor session is offline: {', '.join(sorted(unavailable))}",
            )
        if dirty:
            raise ReadinessBlocked(
                "EDITOR_DIRTY", f"save or discard unsaved files: {', '.join(sorted(set(dirty)))}",
            )
        return participating

    def issue(
        self,
        project_id: str,
        change_id: str,
        review_session_id: str,
        manifest_sha256: str,
        paths: list[str] | tuple[str, ...],
    ) -> dict:
        current = self.now()
        self._leases = {
            key: value for key, value in self._leases.items() if current <= value.expires_at
        }
        if len(self._leases) >= 256:
            raise ReadinessBlocked("EDITOR_UNAVAILABLE", "too many active readiness checks")
        revisions = self._evaluate(
            project_id, change_id, review_session_id, manifest_sha256, paths,
        )
        lease = _Lease(
            lease_id=secrets.token_urlsafe(24),
            project_id=project_id,
            change_id=change_id,
            review_session_id=review_session_id,
            manifest_sha256=manifest_sha256,
            paths=tuple(paths),
            session_revisions=revisions,
            expires_at=current + self.lease_ttl,
        )
        self._leases[lease.lease_id] = lease
        return {
            "lease_id": lease.lease_id,
            "expires_in_ms": int(self.lease_ttl * 1000),
        }

    def consume(
        self,
        lease_id: str,
        project_id: str,
        change_id: str,
        review_session_id: str,
        manifest_sha256: str,
        *,
        paths: list[str] | tuple[str, ...],
    ) -> None:
        lease = self._leases.pop(lease_id, None)
        if (
            lease is None or lease.project_id != project_id or lease.change_id != change_id
            or lease.review_session_id != review_session_id
            or lease.manifest_sha256 != manifest_sha256 or lease.paths != tuple(paths)
            or self.now() > lease.expires_at
        ):
            raise ReadinessBlocked("LEASE_EXPIRED", "readiness lease is invalid or expired")
        revisions = self._evaluate(
            project_id, change_id, review_session_id, manifest_sha256, paths,
        )
        if revisions != lease.session_revisions:
            raise ReadinessBlocked(
                "LEASE_EXPIRED", "editor state changed after readiness was checked",
            )
