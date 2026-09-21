"""Encrypted content-addressed storage for proposed text and recovery backups."""

from __future__ import annotations

import hashlib
import os
import re
import threading
from pathlib import Path
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken

_BLOB_ID = re.compile(r"^[0-9a-f]{64}$")
_MARKER_PLAINTEXT = b"ai-zhagan-protected-content-v1"


class StorageUnavailable(RuntimeError):
    pass


class QuotaExceeded(RuntimeError):
    pass


class KeyProvider(Protocol):
    def get_key(self) -> bytes: ...


class KeyringKeyProvider:
    """Keep the content key in the operating-system credential backend."""

    def __init__(self, identity: str, *, service: str = "AI Zhagan protected content") -> None:
        self.identity = identity
        self.service = service

    def get_key(self) -> bytes:
        try:
            import keyring

            stored = keyring.get_password(self.service, self.identity)
            if stored:
                return stored.encode("ascii")
            key = Fernet.generate_key()
            keyring.set_password(self.service, self.identity, key.decode("ascii"))
            return key
        except Exception as exc:
            raise StorageUnavailable("operating-system credential storage is unavailable") from exc


class ProtectedContentStore:
    def __init__(
        self,
        root: Path,
        key_provider: KeyProvider,
        *,
        max_bytes: int = 1024 * 1024 * 1024,
    ) -> None:
        self.root = Path(root)
        self.objects = self.root / "objects"
        self.marker = self.root / ".key-check"
        self.max_bytes = max_bytes
        self._lock = threading.RLock()
        self.objects.mkdir(parents=True, exist_ok=True)
        try:
            key = key_provider.get_key()
            self._fernet = Fernet(key)
        except StorageUnavailable:
            raise
        except Exception as exc:
            raise StorageUnavailable("protected content key is unavailable") from exc
        self._verify_or_create_marker()

    def _verify_or_create_marker(self) -> None:
        if self.marker.exists():
            try:
                value = self._fernet.decrypt(self.marker.read_bytes())
            except (InvalidToken, OSError) as exc:
                raise StorageUnavailable("protected content key does not match existing data") from exc
            if value != _MARKER_PLAINTEXT:
                raise StorageUnavailable("protected content key marker is invalid")
            return
        if any(self.objects.glob("*.blob")):
            raise StorageUnavailable("protected content key marker is missing for existing data")
        encrypted = self._fernet.encrypt(_MARKER_PLAINTEXT)
        temp = self.root / f".key-check.{os.getpid()}.tmp"
        try:
            temp.write_bytes(encrypted)
            os.replace(temp, self.marker)
        except OSError as exc:
            raise StorageUnavailable("cannot initialize protected content storage") from exc
        finally:
            temp.unlink(missing_ok=True)

    def _path(self, blob_id: str) -> Path:
        if not isinstance(blob_id, str) or not _BLOB_ID.fullmatch(blob_id):
            raise ValueError("invalid blob id")
        return self.objects / f"{blob_id}.blob"

    def total_bytes(self) -> int:
        return sum(path.stat().st_size for path in self.objects.glob("*.blob") if path.is_file())

    def put_bytes(self, data: bytes) -> str:
        if not isinstance(data, bytes):
            raise TypeError("protected content must be bytes")
        blob_id = hashlib.sha256(data).hexdigest()
        target = self._path(blob_id)
        with self._lock:
            if target.exists():
                if self.get_bytes(blob_id) != data:
                    raise StorageUnavailable("content-addressed blob integrity mismatch")
                return blob_id
            encrypted = self._fernet.encrypt(data)
            if len(encrypted) > self.max_bytes or self.total_bytes() + len(encrypted) > self.max_bytes:
                raise QuotaExceeded("QUOTA_EXCEEDED: protected content storage is full")
            temp = self.objects / f".{blob_id}.{os.getpid()}.{threading.get_ident()}.tmp"
            try:
                with temp.open("xb") as stream:
                    stream.write(encrypted)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, target)
            except FileExistsError:
                if not target.exists():
                    raise
            except OSError as exc:
                raise StorageUnavailable("cannot persist protected content") from exc
            finally:
                temp.unlink(missing_ok=True)
        return blob_id

    def get_bytes(self, blob_id: str) -> bytes:
        path = self._path(blob_id)
        try:
            encrypted = path.read_bytes()
            data = self._fernet.decrypt(encrypted)
        except FileNotFoundError as exc:
            raise StorageUnavailable("protected content is missing") from exc
        except (InvalidToken, OSError) as exc:
            raise StorageUnavailable("protected content cannot be decrypted") from exc
        if hashlib.sha256(data).hexdigest() != blob_id:
            raise StorageUnavailable("protected content hash mismatch")
        return data

    def delete(self, blob_id: str) -> None:
        try:
            self._path(blob_id).unlink(missing_ok=True)
        except OSError as exc:
            raise StorageUnavailable("cannot remove protected content") from exc

    def iter_blob_ids(self):
        for path in self.objects.glob("*.blob"):
            if _BLOB_ID.fullmatch(path.stem):
                yield path.stem

    def blob_mtime(self, blob_id: str) -> float:
        return self._path(blob_id).stat().st_mtime
