from __future__ import annotations

import hashlib
import json
import zipfile

import pytest


def test_events_accept_only_bounded_whitelisted_metadata_and_rotate(tmp_path):
    from project_mcp.diagnostics import Diagnostics

    diagnostics = Diagnostics(tmp_path, max_log_bytes=350, max_log_files=3)
    event = {
        "event_type": "change_apply",
        "request_id": "request-1",
        "change_id": "change-1",
        "error_code": None,
        "duration_ms": 12,
        "health": {"local_service": "ok", "oauth": "failed"},
    }
    diagnostics.record_event(event)
    with pytest.raises(ValueError):
        diagnostics.record_event({**event, "source_content": "TOP SECRET SOURCE"})
    with pytest.raises(ValueError):
        diagnostics.record_event({**event, "access_token": "secret-token"})
    for index in range(30):
        diagnostics.record_event({**event, "request_id": f"request-{index}"})
    logs = list(tmp_path.glob("events*.jsonl"))
    assert 1 <= len(logs) <= 3
    assert all(path.stat().st_size <= 700 for path in logs)
    assert "TOP SECRET SOURCE" not in "".join(path.read_text() for path in logs)


def test_export_preview_and_archive_exclude_secrets_content_identity_and_paths(tmp_path):
    from project_mcp.diagnostics import Diagnostics

    diagnostics = Diagnostics(tmp_path / "state")
    diagnostics.record_event({
        "event_type": "change_submit", "request_id": "req", "change_id": "chg",
        "duration_ms": 4, "health": {"local_service": "ok"},
    })
    preview = diagnostics.preview_export(include_paths=False)
    assert preview["path_policy"] == "redacted"
    assert "source contents" in preview["excluded"]
    archive = diagnostics.export_diagnostics(tmp_path / "diagnostics.zip")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert names == ["diagnostics.json"]
        text = bundle.read("diagnostics.json").decode("utf8")
    for secret in (
        "Bearer real-token", "TOP SECRET SOURCE", "oauth-code-123",
        "github-user-999", str(tmp_path),
    ):
        assert secret not in text
    data = json.loads(text)
    assert data["events"][0]["change_id"] == "chg"
    assert data["privacy"]["paths_included"] is False


def test_optional_path_export_uses_explicit_provider_only(tmp_path):
    from project_mcp.diagnostics import Diagnostics

    diagnostics = Diagnostics(
        tmp_path / "state", details_provider=lambda: {
            "projects": [{"id": "demo", "root": str(tmp_path / "project")}],
            "owner": "must-not-export",
        },
    )
    archive = diagnostics.export_diagnostics(
        tmp_path / "with-paths.zip", include_paths=True,
    )
    with zipfile.ZipFile(archive) as bundle:
        data = json.loads(bundle.read("diagnostics.json"))
    assert data["details"]["projects"][0]["root"] == str(tmp_path / "project")
    assert "owner" not in data["details"]


def test_change_service_records_correlated_activity_without_source_text(tmp_path):
    from test_changes_api import MemoryKeyProvider

    from project_mcp.changes.content import ProtectedContentStore
    from project_mcp.changes.store import ChangeStore
    from project_mcp.config import Settings
    from project_mcp.server import Runtime

    (tmp_path / "app.py").write_text("before", encoding="utf8")
    settings = Settings(
        projects=[{"id": "demo", "root": tmp_path, "mode": "propose"}],
        admin_token="a" * 40, mcp_token="m" * 40, state_dir=tmp_path / ".local",
    )
    store = ChangeStore(
        tmp_path / ".state" / "changes.db",
        ProtectedContentStore(tmp_path / ".state" / "content", MemoryKeyProvider()),
    )
    runtime = Runtime(settings, change_store=store)
    result = runtime.get_change_service().submit("private-user-id", {
        "project_id": "demo", "request_id": "request from user", "summary": "change",
        "files": [{
            "path": "app.py", "operation": "modify",
            "base_sha256": hashlib.sha256(b"before").hexdigest(),
            "content_utf8": "TOP SECRET SOURCE",
        }],
    })
    event = runtime.diagnostics.events()[0]
    assert event["change_id"] == result["change_id"]
    assert event["request_id"] != "request from user"
    text = runtime.diagnostics.log_path.read_text(encoding="utf8")
    assert "TOP SECRET SOURCE" not in text
    assert "private-user-id" not in text
