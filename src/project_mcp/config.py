"""Validated configuration; authentication secrets live outside shared project tools."""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .policy import ProjectPolicy


def default_config_path() -> Path:
    override = os.environ.get("AI_ZHAGAN_HOME")
    if override:
        root = Path(override)
    elif os.name == "nt" or os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "AI Zhagan"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "ai-zhagan"
    return (root / "config.json").expanduser().resolve()


class Project(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    root: Path
    name: str = Field(default="", max_length=100)
    mode: Literal["read_only", "propose"] = "read_only"
    paused: bool = False
    apply_local_enabled: bool = False
    share_editor_buffers: bool = False
    exclude_paths: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("exclude_paths")
    @classmethod
    def validate_exclude_paths(cls, values):
        return [ProjectPolicy.validate_pattern(value) for value in values]

    @model_validator(mode="after")
    def validate_root(self):
        if not self.root.is_absolute() or not self.root.is_dir():
            raise ValueError("Project root must be an existing absolute directory")
        self.root = self.root.resolve()
        return self


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config_version: Literal["0.2", "0.3", "1.0"] = "0.2"
    projects: list[Project] = Field(default_factory=list, max_length=64)
    auth_mode: Literal["local", "github"] = "local"
    public_url: str | None = None
    github_user_ids: list[str] = Field(default_factory=list)
    mcp_port: int = Field(default=8765, ge=1024, le=65535)
    admin_port: int = Field(default=8766, ge=1024, le=65535)
    admin_token: str = Field(default="", repr=False)
    mcp_token: str = Field(default="", repr=False)
    state_dir: Path | None = None

    @model_validator(mode="after")
    def constraints(self):
        ids = [project.id for project in self.projects]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate project IDs")
        if self.admin_port == self.mcp_port:
            raise ValueError("MCP and local management must use separate ports")
        if self.public_url:
            u = urlsplit(self.public_url)
            if (u.scheme != "https" or not u.hostname or u.username or u.password
                    or u.query or u.fragment or u.path not in ("", "/")):
                raise ValueError("public_url must be an HTTPS origin, without path or credentials")
            self.public_url = self.public_url.rstrip("/")
            if self.auth_mode != "github":
                raise ValueError("Public access requires GitHub OAuth")
        if self.auth_mode == "github" and (not self.public_url or not self.github_user_ids):
            raise ValueError("GitHub mode requires public_url and github_user_ids")
        if any(not uid.isdecimal() for uid in self.github_user_ids):
            raise ValueError("Use stable numeric GitHub user IDs")
        for token in (self.admin_token, self.mcp_token):
            if token and len(token) < 32:
                raise ValueError("Tokens must have at least 32 characters")
        if self.admin_token and self.admin_token == self.mcp_token:
            raise ValueError("Local and remote tokens must differ")
        return self


def load_config(path: Path) -> Settings:
    path = path.resolve()
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    # Fail invalid config before creating credential files.
    settings = Settings.model_validate(raw)
    state = settings.state_dir or path.parent / ".local"
    if not state.is_absolute():
        state = path.parent / state
    state.mkdir(parents=True, exist_ok=True)
    secret_path = state / "tokens.json"
    try:
        fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump({"admin_token": secrets.token_urlsafe(32),
                       "mcp_token": secrets.token_urlsafe(32)}, stream)
    credentials = json.loads(secret_path.read_text(encoding="utf8"))
    return Settings.model_validate({**raw, **credentials, "state_dir": state.resolve()})


def save_config(path: Path, settings: Settings) -> None:
    data = settings.model_dump(mode="json", exclude={"admin_token", "mcp_token"})
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf8")
    temp.replace(path)


def migrate_config(raw: dict, source_version: str, target_version: str) -> dict:
    """Return an explicit, forward-only config migration without touching disk."""
    versions = ("0.2", "0.3", "1.0")
    if source_version not in versions or target_version not in versions:
        raise ValueError("unsupported config version")
    if versions.index(target_version) < versions.index(source_version):
        raise ValueError("config downgrade is not supported")
    if raw.get("config_version", "0.2") != source_version:
        raise ValueError("config source version does not match")
    result = json.loads(json.dumps(raw))
    for version in versions[versions.index(source_version) + 1:versions.index(target_version) + 1]:
        if version == "0.3":
            for project in result.get("projects", []):
                project.setdefault("mode", "read_only")
                project.setdefault("share_editor_buffers", False)
        if version == "1.0":
            for project in result.get("projects", []):
                project.setdefault("apply_local_enabled", False)
                project.setdefault("exclude_paths", [])
        result["config_version"] = version
    return result
