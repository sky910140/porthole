"""Loopback-only management and adapter API; never mount this on the MCP port."""
from __future__ import annotations

import asyncio
import hmac
import json
import time
from pathlib import Path

from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from .changes.content import QuotaExceeded, StorageUnavailable
from .changes.executor import FileChanged, RecoveryRequired
from .changes.store import IdempotencyConflict, InvalidTransition, RecordUnavailable
from .editor_readiness import ReadinessBlocked
from .protocol import service_info
from .reset import ResetError
from .runtime_limits import BusyError

STATIC = Path(__file__).parent / "static"


class LocalBoundary(BaseHTTPMiddleware):
    def __init__(self, app, token, port):
        super().__init__(app)
        self.token = token.encode()
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.origins = {f"http://{host}" for host in self.hosts}
        self.calls = []

    async def dispatch(self, request, call_next):
        if (request.headers.get("host") not in self.hosts
                or request.headers.get("origin") not in (None, *self.origins)):
            return JSONResponse({"error": "Local origin required"}, status_code=403)
        if request.url.path.startswith("/api/"):
            now = time.monotonic()
            self.calls = [stamp for stamp in self.calls if now - stamp < 60]
            if len(self.calls) >= 180:
                return JSONResponse({"error": "Too many requests"}, status_code=429)
            self.calls.append(now)
            if request.url.path != "/api/pair":
                supplied = request.headers.get("authorization", "")
                if not hmac.compare_digest(supplied.encode(), b"Bearer " + self.token):
                    return JSONResponse({"error": "Local access token required"}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return response


class ResetBoundary(BaseHTTPMiddleware):
    def __init__(self, app, runtime):
        super().__init__(app)
        self.runtime = runtime

    async def dispatch(self, request, call_next):
        if (not request.url.path.startswith("/api/")
                or request.url.path in {"/api/status", "/api/shutdown", "/api/reset/prepare"}):
            return await call_next(request)
        try:
            with self.runtime.operation():
                return await call_next(request)
        except ResetError as exc:
            return JSONResponse({"error": str(exc), "error_code": exc.code}, status_code=409)


async def body(request):
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise ValueError("JSON content type required")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 2_097_152:
            raise ValueError("Request exceeds 2 MiB")
        chunks.append(chunk)
    value = json.loads(b"".join(chunks))
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object")
    return value


def create_app(runtime):
    async def health(request):
        try:
            async with runtime.limits.status.slot():
                runtime.health.record("local_service", "ok")
                return JSONResponse({
                    "service": "porthole",
                    "status": "ok",
                    **service_info().model_dump(mode="json"),
                    "health": runtime.health.snapshot(),
                })
        except BusyError:
            return JSONResponse({"error": "Status service is busy"}, status_code=429)

    async def status(request):
        try:
            async with runtime.limits.status.slot():
                runtime.health.record("local_service", "ok")
                s = runtime.settings
                projects = [{
                    "id": p.id,
                    "name": p.name or p.id,
                    "root": str(p.root),
                    "mode": p.mode,
                    "paused": p.paused,
                    "apply_local_enabled": p.apply_local_enabled,
                    "share_editor_buffers": p.share_editor_buffers,
                    "exclude_paths": p.exclude_paths,
                }
                            for p in s.projects]
                health_state = runtime.health.snapshot()
                return JSONResponse({
                    **service_info().model_dump(mode="json"),
                    "projects": projects,
                    "sessions": runtime.contexts.list(),
                    "editor_readiness_sessions": runtime.editor_readiness.list(),
                    "config_id": runtime.config_id,
                    "auth_mode": s.auth_mode,
                    "account_allowlist_configured": bool(s.github_user_ids),
                    "mcp_port": s.mcp_port,
                    "public_url": s.public_url,
                    "oauth_configured": s.auth_mode == "github",
                    "cloud_account_verified": health_state["oauth"]["state"] == "ok",
                    "read_only": True,
                    "health": health_state,
                    "verification_history": runtime.health.verification_history(),
                    "current_verified_project_id": runtime.health.current_verified_project_id(),
                    "tool_call_project_id": runtime.health.tool_call_project_id(),
                    "recent_tool_activity": runtime.health.recent_tool_activity(),
                    "reset_ready": runtime.reset_ready(request.headers.get("X-Reset-Owner")),
                    "reset_operations_idle": runtime.reset_operations_idle(),
                    "reset_pending": runtime.quiesced,
                })
        except BusyError:
            return JSONResponse({"error": "Status service is busy"}, status_code=429)

    async def action(request: Request):
        try:
            path = request.url.path
            if path == "/api/reset/prepare" and request.method == "POST":
                return JSONResponse(runtime.prepare_reset(request.headers.get("X-Reset-Owner")))
            if path == "/api/pair" and request.method == "POST":
                data = await body(request)
                if not runtime.pairing.consume(str(data.get("pairing_code", ""))):
                    return JSONResponse({"error": "Invalid or expired pairing code"}, status_code=401)
                return JSONResponse({
                    **service_info().model_dump(mode="json"),
                    "service_url": f"http://127.0.0.1:{runtime.settings.admin_port}",
                    "admin_token": runtime.settings.admin_token,
                })
            if path == "/api/shutdown" and request.method == "POST":
                runtime.stop_requested.set()
            elif path == "/api/projects" and request.method == "PUT":
                runtime.update_project(await body(request))
            elif path.startswith("/api/projects/") and request.method == "DELETE":
                runtime.remove_project(request.path_params["project_id"])
            elif path.startswith("/api/projects/") and request.method == "PATCH":
                runtime.update_project_policy(
                    request.path_params["project_id"], await body(request)
                )
            elif path.endswith("/scope") and path.startswith("/api/projects/") and request.method == "GET":
                async with runtime.limits.read.slot():
                    workspace = runtime.workspace(request.path_params["project_id"])
                    return JSONResponse(await asyncio.to_thread(workspace.preview_scope))
            elif path == "/api/context" and request.method == "PUT":
                data = await body(request)
                workspace = runtime.workspace(data.get("project_id", ""))
                return JSONResponse(runtime.contexts.put(workspace, data))
            elif path.startswith("/api/context/") and request.method == "DELETE":
                runtime.contexts.delete(request.path_params["session_id"])
            elif path == "/api/verification-challenges" and request.method == "POST":
                data = await body(request)
                project_id = data.get("project_id", "")
                runtime.workspace(project_id)
                return JSONResponse(runtime.health.create_challenge(project_id))
            elif path == "/api/activity" and request.method == "GET":
                return JSONResponse({"events": runtime.diagnostics.events(limit=100)})
            elif path == "/api/diagnostics/preview" and request.method == "GET":
                include_paths = request.query_params.get("include_paths") == "true"
                return JSONResponse(runtime.diagnostics.preview_export(
                    include_paths=include_paths,
                ))
            elif path == "/api/changes" and request.method == "GET":
                project_id = request.query_params.get("project_id")
                if project_id is not None:
                    runtime.workspace(project_id)
                return JSONResponse({
                    "changes": runtime.local_change_history(project_id),
                })
            elif path.startswith("/api/editor-readiness/") and request.method == "PUT":
                data = await body(request)
                workspace = runtime.workspace(data.get("project_id", ""))
                for document in data.get("documents", []):
                    workspace.resolve_file(document.get("path", ""), "read")
                return JSONResponse(runtime.editor_readiness.update(
                    request.path_params["session_id"], data,
                ))
            elif path.startswith("/api/editor-readiness/") and request.method == "DELETE":
                runtime.editor_readiness.delete(request.path_params["session_id"])
            elif path.startswith("/api/changes/") and request.method == "GET":
                return JSONResponse(runtime.get_change_service().local_detail(
                    request.path_params["change_id"],
                ))
            elif path.endswith("/readiness") and path.startswith("/api/changes/"):
                return JSONResponse(runtime.get_change_service().issue_readiness(
                    request.path_params["change_id"], await body(request),
                ))
            elif path.endswith("/apply") and path.startswith("/api/changes/"):
                result = runtime.get_change_service().apply_reviewed(
                    request.path_params["change_id"], await body(request),
                )
                return JSONResponse(result, status_code=409 if result.get("error_code") else 200)
            elif path.endswith("/reject") and path.startswith("/api/changes/"):
                return JSONResponse(runtime.get_change_service().reject(
                    request.path_params["change_id"], await body(request),
                ))
            elif path.endswith("/revert") and path.startswith("/api/changes/"):
                result = runtime.get_change_service().revert(
                    request.path_params["change_id"], await body(request),
                )
                return JSONResponse(result, status_code=409 if result.get("error_code") else 200)
            elif path.endswith("/recovery") and path.startswith("/api/changes/"):
                result = runtime.get_change_service().recover(
                    request.path_params["change_id"], await body(request),
                )
                return JSONResponse(result, status_code=409 if result.get("error_code") else 200)
            return JSONResponse({"ok": True})
        except ResetError as exc:
            return JSONResponse({"error": str(exc), "error_code": exc.code}, status_code=409)
        except PermissionError:
            return JSONResponse({"error": "Path is not allowed"}, status_code=403)
        except RecordUnavailable:
            return JSONResponse({"error": "Change record unavailable"}, status_code=404)
        except (IdempotencyConflict, InvalidTransition):
            return JSONResponse({"error": "Operation id was reused"}, status_code=409)
        except ReadinessBlocked as exc:
            return JSONResponse({
                "error": exc.message,
                "error_code": exc.error_code,
                "blocked_reason": exc.message,
            }, status_code=409)
        except FileChanged as exc:
            return JSONResponse({
                "error": str(exc), "error_code": "FILE_CHANGED",
            }, status_code=409)
        except RecoveryRequired as exc:
            return JSONResponse({
                "error": str(exc), "error_code": "RECOVERY_REQUIRED",
            }, status_code=409)
        except QuotaExceeded:
            return JSONResponse({"error": "Change storage quota exceeded"}, status_code=429)
        except BusyError:
            return JSONResponse({"error": "Status service is busy"}, status_code=429)
        except (ValueError, TypeError, ValidationError, FileNotFoundError, UnicodeError):
            return JSONResponse({"error": "Invalid request, project or path"}, status_code=400)
        except (OSError, StorageUnavailable):
            return JSONResponse({"error": "Local configuration or file unavailable"}, status_code=503)

    async def static(request):
        name = request.path_params.get("name", "index.html")
        if name not in {"index.html", "app.js", "style.css"}:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return FileResponse(STATIC / name)

    app = Starlette(routes=[Route("/", static), Route("/health", health),
        Route("/api/pair", action, methods=["POST"]),
        Route("/api/status", status), Route("/api/projects", action, methods=["PUT"]),
        Route("/api/shutdown", action, methods=["POST"]),
        Route("/api/reset/prepare", action, methods=["POST"]),
        Route("/api/projects/{project_id}", action, methods=["DELETE", "PATCH"]),
        Route("/api/projects/{project_id}/scope", action, methods=["GET"]),
        Route("/api/context", action, methods=["PUT"]),
        Route("/api/context/{session_id}", action, methods=["DELETE"]),
        Route("/api/verification-challenges", action, methods=["POST"]),
        Route("/api/activity", action, methods=["GET"]),
        Route("/api/diagnostics/preview", action, methods=["GET"]),
        Route("/api/changes", action, methods=["GET"]),
        Route("/api/changes/{change_id}", action, methods=["GET"]),
        Route("/api/changes/{change_id}/readiness", action, methods=["POST"]),
        Route("/api/changes/{change_id}/apply", action, methods=["POST"]),
        Route("/api/changes/{change_id}/reject", action, methods=["POST"]),
        Route("/api/changes/{change_id}/revert", action, methods=["POST"]),
        Route("/api/changes/{change_id}/recovery", action, methods=["POST"]),
        Route("/api/editor-readiness/{session_id}", action, methods=["PUT", "DELETE"]),
        Route("/{name}", static)])
    app.add_middleware(ResetBoundary, runtime=runtime)
    app.add_middleware(LocalBoundary, token=runtime.settings.admin_token,
                       port=runtime.settings.admin_port)
    return app
