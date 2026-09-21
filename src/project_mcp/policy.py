"""Single source of truth for project capabilities and path exclusions."""

from __future__ import annotations

import fnmatch
import hashlib
import json
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

Capability = Literal["read", "propose", "apply_local"]
ProjectMode = Literal["read_only", "propose"]

_EXCLUDED_NAMES = {
    ".git", ".env", ".local", ".ssh", ".codex", ".agents", ".venv",
    "node_modules", "build", "dist", "credentials", "credentials.json",
    "privatekey", "privatekeys", "tokens.json",
}
_SECRET_EXTENSIONS = {".pem", ".key", ".p12", ".pfx"}


def sensitive_path(path: str | PurePosixPath) -> bool:
    parts = PurePosixPath(str(path).replace("\\", "/")).parts
    lowered_path = "/".join(part.lower() for part in parts)
    if lowered_path == "config/local.json" or lowered_path.endswith("/config/local.json"):
        return True
    for part in parts:
        lowered = part.lower()
        stem = lowered.split(".", 1)[0]
        normalized = lowered.replace("_", "").replace("-", "").replace(" ", "")
        if lowered in _EXCLUDED_NAMES or lowered.startswith(".env."):
            return True
        if (
            "credential" in lowered
            or "privatekey" in normalized
            or stem in {"id_rsa", "id_ed25519"}
            or PurePosixPath(lowered).suffix in _SECRET_EXTENSIONS
        ):
            return True
    return False


class ProjectPolicy:
    def __init__(
        self,
        *,
        mode: ProjectMode = "read_only",
        paused: bool = False,
        apply_local_enabled: bool = False,
        share_editor_buffers: bool = False,
        exclude_paths: list[str] | tuple[str, ...] = (),
        repository_rules: dict | None = None,
    ) -> None:
        if mode not in {"read_only", "propose"}:
            raise ValueError("invalid project mode")
        protected = [self.validate_pattern(value) for value in exclude_paths]
        suggestions = (repository_rules or {}).get("exclude", [])
        protected.extend(self.validate_pattern(value) for value in suggestions)
        self.mode = mode
        self.paused = bool(paused)
        self.apply_local_enabled = bool(apply_local_enabled)
        self.share_editor_buffers = bool(share_editor_buffers)
        self.exclude_paths = tuple(dict.fromkeys(protected))
        encoded = json.dumps({
            "mode": mode,
            "paused": self.paused,
            "apply_local_enabled": self.apply_local_enabled,
            "share_editor_buffers": self.share_editor_buffers,
            "exclude_paths": self.exclude_paths,
        }, sort_keys=True).encode()
        self.version = hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def validate_pattern(value: str) -> str:
        if not isinstance(value, str) or not value or "\x00" in value or ":" in value:
            raise ValueError("invalid exclusion pattern")
        windows = PureWindowsPath(value)
        posix = PurePosixPath(value.replace("\\", "/"))
        if windows.is_absolute() or windows.drive or posix.is_absolute():
            raise ValueError("exclusion pattern must be relative")
        if any(part in {"", ".."} or part.endswith((" ", ".")) for part in posix.parts):
            raise ValueError("invalid exclusion pattern")
        return posix.as_posix().lower()

    def with_additional_exclusions(self, values: list[str]) -> ProjectPolicy:
        return ProjectPolicy(
            mode=self.mode,
            paused=self.paused,
            apply_local_enabled=self.apply_local_enabled,
            share_editor_buffers=self.share_editor_buffers,
            exclude_paths=[*self.exclude_paths, *values],
        )

    def exclusion_reason(self, relative_path: str | PurePosixPath) -> str | None:
        normalized = PurePosixPath(str(relative_path).replace("\\", "/")).as_posix().lower()
        if sensitive_path(normalized):
            return "sensitive_path"
        if any(
            fnmatch.fnmatchcase(normalized, pattern)
            or (not any(char in pattern for char in "*?[") and normalized.startswith(pattern + "/"))
            for pattern in self.exclude_paths
        ):
            return "configured_exclusion"
        return None

    def allows(self, relative_path: str | PurePosixPath, capability: Capability) -> bool:
        if capability not in {"read", "propose", "apply_local"}:
            raise ValueError("unknown capability")
        if self.paused or self.exclusion_reason(relative_path):
            return False
        if capability == "read":
            return True
        if capability == "propose":
            return self.mode == "propose"
        return self.mode == "propose" and self.apply_local_enabled

    def allows_editor_buffer(self, relative_path: str | PurePosixPath) -> bool:
        return self.share_editor_buffers and self.allows(relative_path, "read")
