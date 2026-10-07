"""Offline, local-only upgrade snapshots and guarded restore."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from contextlib import closing
from functools import wraps
from pathlib import Path

from .changes.content import ProtectedContentStore, StorageUnavailable
from .config import Settings, migrate_config
from .reset import ResetError, lifecycle_lock, require_no_pending_reset, reset_generation


class UpgradeError(RuntimeError):
    pass


def _serialized(function):
    @wraps(function)
    def wrapped(self, *args, **kwargs):
        try:
            with lifecycle_lock(self.config_path):
                require_no_pending_reset(self.config_path)
                return function(self, *args, **kwargs)
        except ResetError as exc:
            raise UpgradeError(str(exc)) from None
    return wrapped


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _changes_fingerprint(db_path: Path) -> list[list]:
    if not db_path.is_file():
        return []
    with closing(sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise StorageUnavailable("change database integrity check failed")
        return [list(row) for row in connection.execute(
            "SELECT change_id, revision, state FROM changes ORDER BY change_id"
        ).fetchall()]


class UpgradeManager:
    """Snapshot is prepared while the owning service is stopped."""

    def __init__(
        self,
        config_path: Path,
        state_dir: Path,
        runtime_dir: Path,
        *,
        content_store: ProtectedContentStore | None,
        is_running,
    ) -> None:
        self.config_path = Path(config_path).resolve()
        self.state_dir = Path(state_dir).resolve()
        self.runtime_dir = Path(runtime_dir).resolve()
        expected_runtime = self.config_path.parent / "runtime" / "current"
        if self.runtime_dir != expected_runtime:
            raise UpgradeError("managed runtime must be next to the configuration")
        self.content_store = content_store
        self.content_root = self.state_dir / "changes" / "content"
        self.is_running = is_running
        self.db_path = self.state_dir / "changes" / "changes.db"
        self.snapshot_root = self.state_dir / "upgrade-snapshots"
        self.marker = self.state_dir / "upgrade-in-progress.json"

    def _require_stopped(self) -> None:
        require_no_pending_reset(self.config_path)
        if self.is_running():
            raise UpgradeError("stop the local service before upgrading")

    @_serialized
    def prepare_upgrade(self, target_version: str) -> str:
        self._require_stopped()
        if self.content_store is None:
            raise UpgradeError("protected content key is required to verify a snapshot")
        if target_version not in {"0.3", "1.0"}:
            raise UpgradeError("unsupported upgrade target")
        self.snapshot_root.mkdir(parents=True, exist_ok=True)
        snapshot_id = uuid.uuid4().hex
        final = self.snapshot_root / snapshot_id
        marker_fd = None
        owns_marker = False
        try:
            marker_fd = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            owns_marker = True
            with os.fdopen(marker_fd, "w", encoding="utf-8") as stream:
                marker_fd = None
                json.dump({"snapshot_id": snapshot_id, "target_version": target_version}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            final.mkdir()
            shutil.copy2(self.config_path, final / "config.json")
            if self.runtime_dir.is_dir():
                shutil.copytree(self.runtime_dir, final / "runtime")
            fingerprint = _changes_fingerprint(self.db_path)
            if any(row[2] in {"applying", "reverting", "recovery_required"} for row in fingerprint):
                raise UpgradeError("applying, reverting, or recovery_required blocks upgrade")
            if self.db_path.is_file():
                with (
                    closing(sqlite3.connect(
                        f"file:{self.db_path.as_posix()}?mode=ro", uri=True,
                    )) as source,
                    closing(sqlite3.connect(final / "changes.db")) as destination,
                ):
                    source.backup(destination)
                if _changes_fingerprint(final / "changes.db") != fingerprint:
                    raise UpgradeError("change database moved during snapshot")
            content_root = self.content_store.root
            if self.db_path.is_file():
                with closing(sqlite3.connect(
                    f"file:{self.db_path.as_posix()}?mode=ro", uri=True,
                )) as connection:
                    referenced = set()
                    for table, columns in (
                        ("change_files", ("content_blob_id",)),
                        ("transaction_files", ("backup_blob_id", "content_blob_id")),
                    ):
                        for column in columns:
                            referenced.update(row[0] for row in connection.execute(
                                f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL"
                            ))
                for blob_id in referenced:
                    self.content_store.get_bytes(blob_id)
            for blob_id in self.content_store.iter_blob_ids():
                self.content_store.get_bytes(blob_id)
            if content_root.is_dir():
                shutil.copytree(content_root, final / "content")
            files = {
                path.relative_to(final).as_posix(): _sha256(path)
                for path in final.rglob("*") if path.is_file() and not path.is_symlink()
            }
            (final / "manifest.json").write_text(json.dumps({
                "snapshot_id": snapshot_id,
                "target_version": target_version,
                "changes": fingerprint,
                "files": files,
                "reset_generation": reset_generation(self.config_path),
            }), encoding="utf-8")
            return snapshot_id
        except BaseException:
            if marker_fd is not None:
                os.close(marker_fd)
            shutil.rmtree(final, ignore_errors=True)
            if owns_marker:
                self.marker.unlink(missing_ok=True)
            raise

    def _snapshot(self, snapshot_id: str, *, require_marker: bool = True) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", snapshot_id):
            raise UpgradeError("invalid snapshot id")
        snapshot = self.snapshot_root / snapshot_id
        if not (snapshot / "manifest.json").is_file():
            raise UpgradeError("upgrade snapshot is missing")
        manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
        require_no_pending_reset(self.config_path)
        if manifest.get("reset_generation") != reset_generation(self.config_path):
            raise UpgradeError("reset generation changed; old snapshots cannot restore revoked grants")
        files = manifest.get("files", {})
        actual = {
            path.relative_to(snapshot).as_posix(): _sha256(path)
            for path in snapshot.rglob("*")
            if path.is_file() and path.name != "manifest.json" and not path.is_symlink()
        }
        if actual != files or any(path.is_symlink() for path in snapshot.rglob("*")):
            raise UpgradeError("upgrade snapshot checksum mismatch")
        if require_marker:
            marker = json.loads(self.marker.read_text(encoding="utf-8"))
            if marker.get("snapshot_id") != snapshot_id:
                raise UpgradeError("another upgrade is active")
        return snapshot

    @_serialized
    def restore_snapshot(self, snapshot_id: str) -> None:
        self._require_stopped()
        snapshot = self._snapshot(snapshot_id)
        manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
        if _changes_fingerprint(self.db_path) != manifest["changes"]:
            raise UpgradeError("new changes exist; refusing silent rollback")
        replacement = self.runtime_dir.with_name(self.runtime_dir.name + ".restore")
        previous = self.runtime_dir.with_name(self.runtime_dir.name + ".before-restore")
        if replacement.exists() or previous.exists():
            raise UpgradeError("stale restore files require manual inspection")
        if (snapshot / "changes.db").is_file():
            restored_db = self.db_path.with_suffix(".restore")
            shutil.copy2(snapshot / "changes.db", restored_db)
            for suffix in ("-wal", "-shm"):
                self.db_path.with_name(self.db_path.name + suffix).unlink(missing_ok=True)
            os.replace(restored_db, self.db_path)
        restored_config = self.config_path.with_suffix(".restore")
        shutil.copy2(snapshot / "config.json", restored_config)
        os.replace(restored_config, self.config_path)
        # Existing blobs may include later data; retain them rather than deleting user evidence.
        if (snapshot / "content").is_dir():
            shutil.copytree(snapshot / "content", self.content_root, dirs_exist_ok=True)
        if (snapshot / "runtime").is_dir():
            shutil.copytree(snapshot / "runtime", replacement)
        if self.runtime_dir.exists():
            os.replace(self.runtime_dir, previous)
        if replacement.exists():
            os.replace(replacement, self.runtime_dir)
        if previous.exists():
            shutil.rmtree(previous)
        self.marker.unlink()

    @_serialized
    def complete_upgrade(self, snapshot_id: str, *, health_check) -> None:
        self._require_stopped()
        self._snapshot(snapshot_id)
        marker = json.loads(self.marker.read_text(encoding="utf-8"))
        raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        source_version = raw.get("config_version", "0.2")
        target_version = marker["target_version"]
        migrated = migrate_config(raw, source_version, target_version)
        Settings.model_validate(migrated)
        staged = self.config_path.with_suffix(".upgrade")
        staged.write_text(json.dumps(migrated, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(staged, self.config_path)
        if not health_check():
            raise UpgradeError("new runtime health check failed; snapshot remains available")
        staged_marker = self.marker.with_suffix(".pending")
        staged_marker.write_text(json.dumps({**marker, "phase": "awaiting_verification"}), encoding="utf-8")
        os.replace(staged_marker, self.marker)

    def finalize_upgrade(self, snapshot_id: str, *, health_check) -> None:
        require_no_pending_reset(self.config_path)
        self._snapshot(snapshot_id)
        marker = json.loads(self.marker.read_text(encoding="utf-8"))
        if marker.get("phase") != "awaiting_verification":
            raise UpgradeError("offline upgrade checks have not completed")
        if not health_check():
            raise UpgradeError("service health check failed; snapshot remains available")
        receipt = self.verified_receipt(snapshot_id)
        receipt.parent.mkdir(parents=True, exist_ok=True)
        staged = receipt.with_suffix(".tmp")
        staged.write_text(json.dumps({
            "snapshot_id": snapshot_id,
            "config_sha256": _sha256(self.config_path),
            "runtime_sha256": _sha256(self.runtime_dir / "porthole.exe"),
            "changes": _changes_fingerprint(self.db_path),
        }), encoding="utf-8")
        os.replace(staged, receipt)
        self.marker.unlink()

    def verified_receipt(self, snapshot_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", snapshot_id):
            raise UpgradeError("invalid snapshot id")
        return self.state_dir / "verified-upgrades" / f"{snapshot_id}.json"

    @_serialized
    def rollback_verified_snapshot(self, snapshot_id: str) -> None:
        self._require_stopped()
        if self.marker.exists():
            raise UpgradeError("another upgrade is active")
        receipt = self.verified_receipt(snapshot_id)
        if not receipt.is_file():
            raise UpgradeError("verified upgrade receipt is missing")
        recorded = json.loads(receipt.read_text(encoding="utf-8"))
        if recorded.get("snapshot_id") != snapshot_id:
            raise UpgradeError("verified upgrade receipt does not match")
        if _sha256(self.config_path) != recorded.get("config_sha256"):
            raise UpgradeError("configuration changed since upgrade; refusing rollback")
        if _sha256(self.runtime_dir / "porthole.exe") != recorded.get("runtime_sha256"):
            raise UpgradeError("runtime changed since upgrade; refusing rollback")
        if _changes_fingerprint(self.db_path) != recorded.get("changes"):
            raise UpgradeError("new changes exist; refusing silent rollback")
        snapshot = self._snapshot(snapshot_id, require_marker=False)
        manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
        fd = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"snapshot_id": snapshot_id,
                       "target_version": manifest["target_version"]}, stream)
        self.restore_snapshot(snapshot_id)
        receipt.unlink()
