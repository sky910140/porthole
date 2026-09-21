"""SQLite change records with durable idempotency and encrypted content references."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .content import ProtectedContentStore, QuotaExceeded, StorageUnavailable
from .models import ChangeRequest, ChangeResult, ChangeState, canonical_sha256, manifest_document

UNRESOLVED_STATES = {"pending_review", "applying", "reverting", "recovery_required"}
TERMINAL_WITH_CONTENT_EXPIRY = {
    "rejected", "expired", "conflict", "applied", "rolled_back", "reverted",
}


class IdempotencyConflict(RuntimeError):
    pass


class RecordUnavailable(RuntimeError):
    pass


class InvalidTransition(RuntimeError):
    pass


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


class ChangeStore:
    def __init__(
        self,
        db_path: Path,
        content_store: ProtectedContentStore,
        *,
        max_pending: int = 100,
        fault_injector: Callable[[str], None] | None = None,
    ) -> None:
        self.db_path = Path(db_path)
        self.content = content_store
        self.max_pending = max_pending
        self.fault = fault_injector or (lambda _point: None)
        self._lock = threading.RLock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        try:
            connection = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
            return connection
        except sqlite3.DatabaseError as exc:
            raise StorageUnavailable("change database is unavailable") from exc

    def _initialize(self) -> None:
        existed = self.db_path.exists() and self.db_path.stat().st_size > 0
        try:
            with self._connect() as connection:
                if existed and connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise StorageUnavailable("change database integrity check failed")
                connection.executescript("""
                    PRAGMA journal_mode=WAL;
                    PRAGMA synchronous=FULL;
                    CREATE TABLE IF NOT EXISTS changes (
                        change_id TEXT PRIMARY KEY,
                        actor_id TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        request_id TEXT NOT NULL,
                        request_sha256 TEXT NOT NULL,
                        manifest_sha256 TEXT NOT NULL,
                        summary TEXT NOT NULL,
                        state TEXT NOT NULL,
                        revision INTEGER NOT NULL,
                        blocked_reason TEXT,
                        error_code TEXT,
                        transaction_kind TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        expires_at TEXT NOT NULL,
                        UNIQUE(actor_id, project_id, request_id)
                    );
                    CREATE TABLE IF NOT EXISTS change_files (
                        change_id TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE,
                        ordinal INTEGER NOT NULL,
                        path TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        base_sha256 TEXT,
                        content_sha256 TEXT NOT NULL,
                        content_blob_id TEXT,
                        PRIMARY KEY(change_id, ordinal),
                        UNIQUE(change_id, path)
                    );
                    CREATE TABLE IF NOT EXISTS operations (
                        operation_id TEXT PRIMARY KEY,
                        change_id TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE,
                        actor_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        parameters_sha256 TEXT NOT NULL,
                        result_json TEXT,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS transactions (
                        change_id TEXT NOT NULL REFERENCES changes(change_id) ON DELETE CASCADE,
                        kind TEXT NOT NULL,
                        phase TEXT NOT NULL,
                        started_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY(change_id, kind)
                    );
                    CREATE TABLE IF NOT EXISTS transaction_files (
                        change_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        ordinal INTEGER NOT NULL,
                        path TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        before_sha256 TEXT,
                        after_sha256 TEXT NOT NULL,
                        backup_blob_id TEXT,
                        content_blob_id TEXT,
                        original_mode INTEGER,
                        phase TEXT NOT NULL,
                        PRIMARY KEY(change_id, kind, ordinal),
                        FOREIGN KEY(change_id, kind)
                            REFERENCES transactions(change_id, kind) ON DELETE CASCADE
                    );
                """)
        except StorageUnavailable:
            raise
        except sqlite3.DatabaseError as exc:
            raise StorageUnavailable("change database is corrupt or unavailable") from exc

    @staticmethod
    def _actor(actor_id: str) -> str:
        if not isinstance(actor_id, str) or not actor_id.strip() or len(actor_id) > 200:
            raise ValueError("authenticated actor id is required")
        return actor_id.strip()

    @staticmethod
    def _result(row: sqlite3.Row) -> dict:
        return ChangeResult(
            change_id=row["change_id"], state=row["state"],
            manifest_sha256=row["manifest_sha256"], revision=row["revision"],
            blocked_reason=row["blocked_reason"], error_code=row["error_code"],
        ).model_dump(mode="json")

    def create(
        self,
        actor_id: str,
        request: ChangeRequest | dict,
        *,
        now: datetime | None = None,
    ) -> dict:
        actor = self._actor(actor_id)
        value = request if isinstance(request, ChangeRequest) else ChangeRequest.model_validate(request)
        manifest = manifest_document(value)
        digest = canonical_sha256(manifest)
        timestamp = now or datetime.now(UTC)
        expires = timestamp + timedelta(hours=24)
        with self._lock:
            with self._connect() as connection:
                existing = connection.execute(
                    "SELECT * FROM changes WHERE actor_id=? AND project_id=? AND request_id=?",
                    (actor, value.project_id, value.request_id),
                ).fetchone()
                if existing:
                    if existing["request_sha256"] != digest:
                        raise IdempotencyConflict("IDEMPOTENCY_CONFLICT: request id has different content")
                    return self._result(existing)
                pending = connection.execute(
                    "SELECT COUNT(*) FROM changes WHERE state IN ('pending_review','applying','reverting','recovery_required')"
                ).fetchone()[0]
                if pending >= self.max_pending:
                    raise QuotaExceeded("QUOTA_EXCEEDED: too many pending changes")

            stored = []
            for item, file_manifest in zip(value.files, manifest["files"], strict=True):
                blob_id = self.content.put_bytes(item.content_utf8.encode("utf-8"))
                stored.append((item, file_manifest, blob_id))
            self.fault("before_database_insert")

            change_id = str(uuid.uuid4())
            try:
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    existing = connection.execute(
                        "SELECT * FROM changes WHERE actor_id=? AND project_id=? AND request_id=?",
                        (actor, value.project_id, value.request_id),
                    ).fetchone()
                    if existing:
                        connection.rollback()
                        if existing["request_sha256"] != digest:
                            raise IdempotencyConflict(
                                "IDEMPOTENCY_CONFLICT: request id has different content"
                            )
                        return self._result(existing)
                    pending = connection.execute(
                        "SELECT COUNT(*) FROM changes WHERE state IN ('pending_review','applying','reverting','recovery_required')"
                    ).fetchone()[0]
                    if pending >= self.max_pending:
                        connection.rollback()
                        raise QuotaExceeded("QUOTA_EXCEEDED: too many pending changes")
                    connection.execute(
                        """INSERT INTO changes (
                            change_id,actor_id,project_id,request_id,request_sha256,
                            manifest_sha256,summary,state,revision,created_at,updated_at,expires_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            change_id, actor, value.project_id, value.request_id, digest,
                            digest, value.summary, "pending_review", 1,
                            _iso(timestamp), _iso(timestamp), _iso(expires),
                        ),
                    )
                    connection.executemany(
                        """INSERT INTO change_files (
                            change_id,ordinal,path,operation,base_sha256,content_sha256,content_blob_id
                        ) VALUES (?,?,?,?,?,?,?)""",
                        [(
                            change_id, index, item.path, item.operation, item.base_sha256,
                            file_manifest["content_sha256"], blob_id,
                        ) for index, (item, file_manifest, blob_id) in enumerate(stored)],
                    )
                    connection.commit()
                    row = connection.execute(
                        "SELECT * FROM changes WHERE change_id=?", (change_id,)
                    ).fetchone()
                    return self._result(row)
            except (sqlite3.DatabaseError, OSError) as exc:
                raise StorageUnavailable("failed to persist change record") from exc

    def _row(self, actor_id: str, project_id: str, change_id: str) -> sqlite3.Row:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM changes WHERE actor_id=? AND project_id=? AND change_id=?",
                (self._actor(actor_id), project_id, change_id),
            ).fetchone()
        if row is None:
            raise RecordUnavailable("RECORD_UNAVAILABLE: change record does not exist or is unavailable")
        return row

    def get(self, actor_id: str, project_id: str, change_id: str) -> dict:
        return self._result(self._row(actor_id, project_id, change_id))

    def transaction_kind(self, actor_id: str, project_id: str, change_id: str) -> str:
        row = self._row(actor_id, project_id, change_id)
        if row["transaction_kind"] not in {"apply", "revert"}:
            raise RecordUnavailable("transaction kind is unavailable")
        return row["transaction_kind"]

    def files(self, actor_id: str, project_id: str, change_id: str) -> list[dict]:
        row = self._row(actor_id, project_id, change_id)
        with self._connect() as connection:
            values = connection.execute(
                """SELECT path,operation,base_sha256,content_sha256,content_blob_id
                   FROM change_files WHERE change_id=? ORDER BY ordinal""",
                (row["change_id"],),
            ).fetchall()
        return [dict(item) for item in values]

    def transition(
        self,
        actor_id: str,
        project_id: str,
        change_id: str,
        *,
        expected_revision: int,
        expected_states: Iterable[ChangeState],
        new_state: ChangeState,
        transaction_kind: str | None = None,
        blocked_reason: str | None = None,
        error_code: str | None = None,
        now: datetime | None = None,
    ) -> dict:
        states = tuple(expected_states)
        if not states:
            raise ValueError("at least one expected state is required")
        placeholders = ",".join("?" for _ in states)
        timestamp = _iso(now or datetime.now(UTC))
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"""UPDATE changes SET state=?,revision=revision+1,transaction_kind=?,
                    blocked_reason=?,error_code=?,updated_at=?
                    WHERE actor_id=? AND project_id=? AND change_id=? AND revision=?
                    AND state IN ({placeholders})""",
                (
                    new_state, transaction_kind, blocked_reason, error_code, timestamp,
                    self._actor(actor_id), project_id, change_id, expected_revision, *states,
                ),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise InvalidTransition("revision or state changed")
            connection.commit()
            row = connection.execute(
                "SELECT * FROM changes WHERE change_id=?", (change_id,)
            ).fetchone()
            return self._result(row)

    def count_changes(self) -> int:
        with self._connect() as connection:
            return connection.execute("SELECT COUNT(*) FROM changes").fetchone()[0]

    def start_transaction(
        self,
        actor_id: str,
        project_id: str,
        change_id: str,
        *,
        expected_revision: int,
        expected_state: ChangeState,
        kind: str,
        files: list[dict],
        now: datetime | None = None,
    ) -> dict:
        if kind not in {"apply", "revert"}:
            raise ValueError("invalid transaction kind")
        next_state = "applying" if kind == "apply" else "reverting"
        timestamp = _iso(now or datetime.now(UTC))
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM changes WHERE actor_id=? AND project_id=? AND change_id=?",
                (self._actor(actor_id), project_id, change_id),
            ).fetchone()
            if (
                row is None or row["revision"] != expected_revision
                or row["state"] != expected_state
            ):
                connection.rollback()
                raise InvalidTransition("revision or state changed")
            blocked = connection.execute(
                """SELECT 1 FROM changes WHERE project_id=? AND state='recovery_required'
                   AND change_id<>? LIMIT 1""",
                (project_id, change_id),
            ).fetchone()
            if blocked:
                connection.rollback()
                raise InvalidTransition("RECOVERY_REQUIRED: project has an unresolved transaction")
            connection.execute(
                """UPDATE changes SET state=?,revision=revision+1,transaction_kind=?,
                   blocked_reason=NULL,error_code=NULL,updated_at=? WHERE change_id=?""",
                (next_state, kind, timestamp, change_id),
            )
            connection.execute(
                "INSERT INTO transactions VALUES (?,?,?,?,?)",
                (change_id, kind, "active", timestamp, timestamp),
            )
            connection.executemany(
                """INSERT INTO transaction_files (
                    change_id,kind,ordinal,path,operation,before_sha256,after_sha256,
                    backup_blob_id,content_blob_id,original_mode,phase
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                [(
                    change_id, kind, index, item["path"], item["operation"],
                    item.get("before_sha256"), item["after_sha256"],
                    item.get("backup_blob_id"), item["content_blob_id"],
                    item.get("original_mode"), "prepared",
                ) for index, item in enumerate(files)],
            )
            connection.commit()
            updated = connection.execute(
                "SELECT * FROM changes WHERE change_id=?", (change_id,)
            ).fetchone()
            return self._result(updated)

    def transaction(self, change_id: str, kind: str) -> dict:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM transactions WHERE change_id=? AND kind=?",
                (change_id, kind),
            ).fetchone()
            if row is None:
                raise RecordUnavailable("transaction record is unavailable")
            files = connection.execute(
                """SELECT ordinal,path,operation,before_sha256,after_sha256,backup_blob_id,
                          content_blob_id,original_mode,phase
                   FROM transaction_files WHERE change_id=? AND kind=? ORDER BY ordinal""",
                (change_id, kind),
            ).fetchall()
        return {**dict(row), "files": [dict(item) for item in files]}

    def set_transaction_file_phase(
        self, change_id: str, kind: str, ordinal: int, phase: str,
    ) -> None:
        with self._lock, self._connect() as connection:
            if connection.execute(
                """UPDATE transaction_files SET phase=?
                   WHERE change_id=? AND kind=? AND ordinal=?""",
                (phase, change_id, kind, ordinal),
            ).rowcount != 1:
                raise RecordUnavailable("transaction file record is unavailable")
            connection.execute(
                "UPDATE transactions SET updated_at=? WHERE change_id=? AND kind=?",
                (_iso(datetime.now(UTC)), change_id, kind),
            )

    def set_transaction_phase(self, change_id: str, kind: str, phase: str) -> None:
        with self._lock, self._connect() as connection:
            if connection.execute(
                """UPDATE transactions SET phase=?,updated_at=?
                   WHERE change_id=? AND kind=?""",
                (phase, _iso(datetime.now(UTC)), change_id, kind),
            ).rowcount != 1:
                raise RecordUnavailable("transaction record is unavailable")

    def _referenced(self) -> set[str]:
        with self._connect() as connection:
            return {
                row[0] for row in connection.execute(
                    """SELECT content_blob_id FROM change_files WHERE content_blob_id IS NOT NULL
                       UNION SELECT content_blob_id FROM transaction_files
                             WHERE content_blob_id IS NOT NULL
                       UNION SELECT backup_blob_id FROM transaction_files
                             WHERE backup_blob_id IS NOT NULL"""
                )
            }

    def cleanup_orphans(self, *, grace_seconds: int = 3600) -> int:
        referenced = self._referenced()
        cutoff = time.time() - grace_seconds
        removed = 0
        for blob_id in list(self.content.iter_blob_ids()):
            if blob_id not in referenced and self.content.blob_mtime(blob_id) <= cutoff:
                self.content.delete(blob_id)
                removed += 1
        return removed

    def cleanup(
        self,
        *,
        now: datetime | None = None,
        content_retention_days: int = 7,
        record_retention_days: int = 30,
    ) -> dict[str, int]:
        value = now or datetime.now(UTC)
        content_cutoff = _iso(value - timedelta(days=content_retention_days))
        record_cutoff = _iso(value - timedelta(days=record_retention_days))
        now_text = _iso(value)
        released: list[str] = []
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            expired = connection.execute(
                """UPDATE changes SET state='expired',revision=revision+1,updated_at=?
                   WHERE state='pending_review' AND expires_at<?""",
                (now_text, now_text),
            ).rowcount
            placeholders = ",".join("?" for _ in TERMINAL_WITH_CONTENT_EXPIRY)
            expiry_parameters = (*sorted(TERMINAL_WITH_CONTENT_EXPIRY), content_cutoff)
            rows = connection.execute(
                f"""SELECT f.content_blob_id AS blob_id
                    FROM change_files f JOIN changes c USING(change_id)
                    WHERE f.content_blob_id IS NOT NULL AND c.state IN ({placeholders})
                    AND c.updated_at<?
                    UNION SELECT t.content_blob_id
                    FROM transaction_files t JOIN changes c USING(change_id)
                    WHERE t.content_blob_id IS NOT NULL AND c.state IN ({placeholders})
                    AND c.updated_at<?
                    UNION SELECT t.backup_blob_id
                    FROM transaction_files t JOIN changes c USING(change_id)
                    WHERE t.backup_blob_id IS NOT NULL AND c.state IN ({placeholders})
                    AND c.updated_at<?""",
                (*expiry_parameters, *expiry_parameters, *expiry_parameters),
            ).fetchall()
            released = [row[0] for row in rows]
            connection.execute(
                f"""UPDATE change_files SET content_blob_id=NULL WHERE change_id IN (
                    SELECT change_id FROM changes WHERE state IN ({placeholders}) AND updated_at<?
                )""",
                (*sorted(TERMINAL_WITH_CONTENT_EXPIRY), content_cutoff),
            )
            connection.execute(
                f"""UPDATE transaction_files SET content_blob_id=NULL,backup_blob_id=NULL
                    WHERE change_id IN (
                        SELECT change_id FROM changes WHERE state IN ({placeholders})
                        AND updated_at<?
                    )""",
                (*sorted(TERMINAL_WITH_CONTENT_EXPIRY), content_cutoff),
            )
            deleted = connection.execute(
                f"""DELETE FROM changes WHERE state NOT IN ({','.join('?' for _ in UNRESOLVED_STATES)})
                    AND updated_at<?""",
                (*sorted(UNRESOLVED_STATES), record_cutoff),
            ).rowcount
            connection.commit()
        referenced = self._referenced()
        for blob_id in set(released) - referenced:
            self.content.delete(blob_id)
        return {"expired": expired, "released_blobs": len(set(released)), "deleted": deleted}

    def verify_references(self) -> dict[str, list[str]]:
        referenced = self._referenced()
        present = set(self.content.iter_blob_ids())
        return {
            "missing": sorted(referenced - present),
            "orphaned": sorted(present - referenced),
        }

    def backup_to(self, target: Path) -> dict:
        target = Path(target)
        if target.exists():
            raise FileExistsError(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as source, sqlite3.connect(target) as destination:
            source.backup(destination)
        references = self.verify_references()
        if references["missing"]:
            raise StorageUnavailable("cannot create consistent backup with missing blobs")
        return {
            "database": str(target),
            "integrity": "ok",
            "referenced_blobs": sorted(self._referenced()),
            "orphaned_blobs": references["orphaned"],
        }

    def begin_operation(
        self,
        operation_id: str,
        change_id: str,
        actor_id: str,
        kind: str,
        parameters: dict,
        *,
        now: datetime | None = None,
    ) -> dict | None:
        digest = canonical_sha256(parameters)
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM operations WHERE operation_id=?", (operation_id,)
            ).fetchone()
            if existing:
                if (
                    existing["change_id"] != change_id or existing["actor_id"] != actor_id
                    or existing["kind"] != kind or existing["parameters_sha256"] != digest
                ):
                    raise IdempotencyConflict("IDEMPOTENCY_CONFLICT: operation id was reused")
                return json.loads(existing["result_json"]) if existing["result_json"] else None
            connection.execute(
                "INSERT INTO operations VALUES (?,?,?,?,?,?,?)",
                (operation_id, change_id, actor_id, kind, digest, None, _iso(now or datetime.now(UTC))),
            )
        return None

    def finish_operation(self, operation_id: str, result: dict) -> None:
        encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
        with self._lock, self._connect() as connection:
            if connection.execute(
                "UPDATE operations SET result_json=? WHERE operation_id=? AND result_json IS NULL",
                (encoded, operation_id),
            ).rowcount != 1:
                existing = connection.execute(
                    "SELECT result_json FROM operations WHERE operation_id=?", (operation_id,)
                ).fetchone()
                if existing is None or existing[0] != encoded:
                    raise IdempotencyConflict("operation result already differs")
