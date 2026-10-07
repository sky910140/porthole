"""Resumable local authorization reset; project content and recovery history survive."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx

from .config import Settings


class ResetError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


OWNED_STATE = ("oauth", "pairing.json", "verification-history.json", "diagnostics")
RESET_PROFILE_LOCK_TIMEOUT = 0.5
_held_locks = threading.local()


def marker_path(config: Path) -> Path:
    return Path(config).absolute().parent / ".reset-in-progress.json"


def receipt_path(config: Path) -> Path:
    return Path(config).absolute().parent / ".reset-receipt.json"


def reject_links(path: Path, *, recursive: bool = False) -> None:
    """Inspect lexical ancestors before resolving, including Windows reparse points."""
    path = Path(path).absolute()
    for item in (*reversed(path.parents), path):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ResetError("RESET_UNSAFE_PATH", "Linked reset paths require manual inspection")
    if recursive and path.is_dir():
        for child in path.iterdir():
            reject_links(child, recursive=True)


def require_no_pending_reset(config: Path) -> None:
    marker = marker_path(config)
    reject_links(marker)
    if marker.exists():
        raise ResetError("RESET_PENDING", "Resume local reset before starting or upgrading")


def _json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise TypeError
        return data
    except (OSError, ValueError, TypeError):
        raise ResetError("RESET_STATE_UNAVAILABLE", "Local reset state is unavailable; retry after inspection") from None


def _atomic_json(path: Path, data: dict) -> None:
    reject_links(path)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def lifecycle_lock(config: Path, *, timeout: float = 10):
    """OS locks release after a crash; the service holds this through socket teardown."""
    with _file_lock(config, ".lifecycle.lock", timeout=timeout):
        yield


@contextmanager
def reset_lock(config: Path):
    """Serialize reset attempts with local commands that can create new grants."""
    with _file_lock(config, ".reset.lock", timeout=15):
        yield


@contextmanager
def profile_edit_lock(config: Path, *, timeout: float = 0):
    """Hold across editor config writes and rollback so reset cannot race an old plan."""
    with _file_lock(config, ".profile-edit.lock", timeout=timeout):
        yield


def reset_owner(config: Path, nonce: str | None) -> bool:
    if not nonce or not re.fullmatch(r"[0-9a-f]{64}", nonce):
        return False
    checkpoint = marker_path(config)
    try:
        reject_links(checkpoint)
        stored = _json(checkpoint).get("prepare_nonce", "")
        return isinstance(stored, str) and hmac.compare_digest(stored, nonce)
    except ResetError:
        return False


@contextmanager
def _file_lock(config: Path, name: str, *, timeout: float):
    lock = Path(config).absolute().parent / name
    reject_links(lock)
    held = getattr(_held_locks, "paths", {})
    if str(lock) in held:
        yield
        return
    stream = lock.open("a+b")
    acquired = False
    deadline = time.monotonic() + timeout
    try:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        while True:
            try:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                held[str(lock)] = True
                _held_locks.paths = held
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise ResetError("RESET_BUSY", "Another lifecycle operation is active") from None
                time.sleep(0.05)
        yield
    finally:
        if acquired:
            held.pop(str(lock), None)
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()


def reset_generation(config: Path) -> str | None:
    receipt = receipt_path(config)
    reject_links(receipt)
    if not receipt.exists():
        return None
    generation = _json(receipt).get("reset_id")
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{32}", generation):
        raise ResetError("RESET_STATE_UNAVAILABLE", "Reset receipt requires inspection")
    return generation


@contextmanager
def _history_database(database: Path):
    """SQLite mode=ro still writes WAL read marks; inspect a private copy when WAL exists."""
    wal = database.with_name(database.name + "-wal")
    reject_links(wal)
    reject_links(database.with_name(database.name + "-shm"))
    if not wal.is_file() or not wal.stat().st_size:
        yield database.as_uri() + "?mode=ro&immutable=1"
        return
    with tempfile.TemporaryDirectory(prefix="porthole-reset-") as directory:
        copied = Path(directory) / database.name
        shutil.copyfile(database, copied)
        shutil.copyfile(wal, copied.with_name(copied.name + "-wal"))
        yield copied.as_uri() + "?mode=ro"


class LocalReset:
    def __init__(self, config: Path):
        self.config = Path(config).absolute()
        reject_links(self.config)
        self.raw = _json(self.config)
        try:
            # Revoking a grant does not require its former project directory to exist.
            self.settings = Settings.model_validate({**self.raw, "projects": []})
        except ValueError:
            raise ResetError("RESET_CONFIG_UNAVAILABLE", "Configuration must be repaired before local reset") from None
        state = self.settings.state_dir or self.config.parent / ".local"
        if not state.is_absolute():
            state = self.config.parent / state
        reject_links(state)
        self.state = state.resolve()
        self.marker = marker_path(self.config)
        self.receipt = receipt_path(self.config)
        self.checkpoint = None
        self.validate_paths()
        reset_generation(self.config)
        if self.marker.exists():
            self.checkpoint = _json(self.marker)
            if (not isinstance(self.checkpoint.get("reset_id"), str)
                    or not re.fullmatch(r"[0-9a-f]{32}", self.checkpoint["reset_id"])
                    or self.checkpoint.get("phase") not in {"prepared", "credentials_rotated"}
                    or self.checkpoint.get("config_id") != self.config_id
                    or self.checkpoint.get("state_dir") != str(self.state)):
                raise ResetError("RESET_STATE_UNAVAILABLE", "Reset checkpoint requires inspection")

    @property
    def config_id(self):
        return hashlib.sha256(str(self.config.resolve()).encode()).hexdigest()

    def validate_paths(self):
        for path in (self.config, self.marker, self.receipt, self.state / "tokens.json",
                     self.state / "upgrade-in-progress.json", self.state / "changes" / "changes.db"):
            reject_links(path)
        for name in OWNED_STATE:
            reject_links(self.state / name, recursive=True)

    def ensure_safe(self):
        self.validate_paths()
        if (self.state / "upgrade-in-progress.json").exists():
            raise ResetError("RESET_BUSY", "Complete or restore the active upgrade before reset")
        database = self.state / "changes" / "changes.db"
        if database.exists():
            try:
                with _history_database(database) as source, closing(sqlite3.connect(source, uri=True)) as connection:
                    unsafe = connection.execute(
                        "SELECT 1 FROM changes WHERE state IN ('applying','reverting','recovery_required') LIMIT 1"
                    ).fetchone()
                    if unsafe:
                        raise ResetError("RESET_BUSY", "Applying, reverting or recovery-required changes block reset")
            except sqlite3.Error:
                raise ResetError("RESET_STATE_UNAVAILABLE", "Change history requires inspection before reset") from None

    def _live(self):
        token_file = self.state / "tokens.json"
        tokens = _json(token_file) if token_file.exists() else {}
        token = tokens.get("admin_token", self.raw.get("admin_token", ""))
        if not isinstance(token, str) or not token:
            return None, ""
        try:
            headers = {"Authorization": "Bearer " + token}
            if self.checkpoint and self.checkpoint.get("prepare_nonce"):
                headers["X-Reset-Owner"] = self.checkpoint["prepare_nonce"]
            response = httpx.get(self._url("status"), headers=headers,
                                 timeout=1, trust_env=False)
            data = response.json() if response.status_code == 200 else None
            if isinstance(data, dict) and data.get("config_id") == self.config_id:
                return data, token
        except (httpx.HTTPError, ValueError):
            pass
        return None, token

    def _url(self, action):
        return f"http://127.0.0.1:{self.settings.admin_port}/api/{action}"

    def _ports_available(self):
        sockets = []
        try:
            for port in (self.settings.admin_port, self.settings.mcp_port):
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sockets.append(sock)
                if os.name == "nt":
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                sock.bind(("127.0.0.1", port))
        except OSError:
            raise ResetError("RESET_PORT_IN_USE", "Configured ports belong to an unverified service; stop it manually") from None
        finally:
            for sock in sockets:
                sock.close()

    def check(self):
        with profile_edit_lock(self.config, timeout=RESET_PROFILE_LOCK_TIMEOUT):
            return self._check(profile_owned=True)

    def _check(self, *, profile_owned: bool = False):
        self.ensure_safe()
        live, _token = self._live()
        if live:
            if "initial_reset" not in live.get("capabilities", []):
                raise ResetError("RESET_INCOMPATIBLE", "Use Check and install bundled version before resetting this service")
            readiness = (live.get("reset_operations_idle", live.get("reset_ready", False))
                         if profile_owned else live.get("reset_ready", False))
            if not readiness:
                raise ResetError("RESET_BUSY", "Active local operations block reset; retry when idle")
        else:
            self._ports_available()
        return {"ready": True, "reset_id": self.checkpoint["reset_id"] if self.checkpoint else None}

    def prepare(self, *, owner_nonce: str | None = None):
        self.ensure_safe()
        if self.checkpoint is None:
            self.checkpoint = {"reset_id": uuid.uuid4().hex, "config_id": self.config_id,
                               "state_dir": str(self.state), "phase": "prepared"}
            _atomic_json(self.marker, self.checkpoint)
        if owner_nonce is not None:
            self.checkpoint["prepare_nonce"] = owner_nonce
            _atomic_json(self.marker, self.checkpoint)
        return {"reset_id": self.checkpoint["reset_id"]}

    def _clear_vault(self):
        import keyring

        from .auth import _vault_service, clear_github_credentials
        try:
            clear_github_credentials(self.state)
            # PasswordDeleteError may mean missing OR refusal. Verify both fields are gone.
            service = _vault_service(self.state)
            if any(keyring.get_password(service, name) is not None for name in ("client_id", "client_secret")):
                raise RuntimeError
        except Exception:  # noqa: BLE001 - Vault backends may raise provider-specific errors.
            raise ResetError("RESET_VAULT_UNAVAILABLE", "Operating system credentials could not be cleared; resume local reset") from None

    def _fingerprint(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

    def _already_reset(self):
        if self.checkpoint or not self.receipt.exists():
            return False
        receipt = _json(self.receipt)
        import keyring

        from .auth import _vault_service
        try:
            if any(keyring.get_password(_vault_service(self.state), name) is not None
                   for name in ("client_id", "client_secret")):
                return False
        except Exception:  # noqa: BLE001 - Failure must enter the checkpointed cleanup path.
            return False
        return (bool(receipt.get("reset_id"))
                and receipt.get("config_sha256") == self._fingerprint(self.config)
                and receipt.get("tokens_sha256") == self._fingerprint(self.state / "tokens.json")
                and not any((self.state / name).exists() for name in OWNED_STATE))

    def run(self):
        with reset_lock(self.config), profile_edit_lock(self.config, timeout=RESET_PROFILE_LOCK_TIMEOUT):
            return self._run()

    def _run(self):
        self._check(profile_owned=True)
        live, token = self._live()
        if live:
            nonce = secrets.token_hex(32)
            self.prepare(owner_nonce=nonce)
            try:
                response = httpx.post(self._url("reset/prepare"), headers={"Authorization": "Bearer " + token,
                                      "X-Reset-Owner": nonce},
                                      timeout=3, trust_env=False)
                if response.status_code != 200:
                    raise ResetError("RESET_BUSY", "Service could not prepare reset; retry when idle")
                # Only an authenticated service matching config_id may be shut down.
                response = httpx.post(self._url("shutdown"), headers={"Authorization": "Bearer " + token},
                                      timeout=3, trust_env=False)
                response.raise_for_status()
            except httpx.HTTPError:
                raise ResetError("RESET_STOP_FAILED", "Prepared service could not stop; resume local reset") from None
            for _ in range(80):
                try:
                    self._ports_available()
                    break
                except ResetError:
                    time.sleep(0.1)
            else:
                raise ResetError("RESET_STOP_FAILED", "Prepared service did not release its ports; resume local reset")
        with lifecycle_lock(self.config):
            current = LocalReset(self.config)
            current.ensure_safe()
            current._ports_available()
            if current._already_reset():
                current._clear_vault()
                return {"reset_id": _json(current.receipt)["reset_id"], "local_reset": True}
            current.prepare()
            current._clear_vault()
            current.state.mkdir(parents=True, exist_ok=True)
            if current.checkpoint["phase"] == "prepared":
                _atomic_json(current.state / "tokens.json", {
                    "admin_token": secrets.token_urlsafe(32), "mcp_token": secrets.token_urlsafe(32),
                })
                current.checkpoint["phase"] = "credentials_rotated"
                _atomic_json(current.marker, current.checkpoint)
            current.validate_paths()
            for name in OWNED_STATE:
                owned = current.state / name
                if owned.is_dir():
                    shutil.rmtree(owned)
                else:
                    owned.unlink(missing_ok=True)
            clean = Settings(config_version=current.settings.config_version,
                             mcp_port=current.settings.mcp_port, admin_port=current.settings.admin_port,
                             state_dir=current.settings.state_dir)
            _atomic_json(current.config, clean.model_dump(mode="json", exclude={"admin_token", "mcp_token"}))
            _atomic_json(current.receipt, {
                "reset_id": current.checkpoint["reset_id"], "completed_at": datetime.now(UTC).isoformat(),
                "config_sha256": current._fingerprint(current.config),
                "tokens_sha256": current._fingerprint(current.state / "tokens.json"),
            })
            current.marker.unlink()
            return {"reset_id": current.checkpoint["reset_id"], "local_reset": True}
