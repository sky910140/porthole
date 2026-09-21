"""Loopback-only management and adapter API; never mount this on the MCP port."""
from __future__ import annotations

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
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied.encode(), b"Bearer " + self.token):
                return JSONResponse({"error": "Local access token required"}, status_code=401)
            now = time.monotonic()
            self.calls = [stamp for stamp in self.calls if now - stamp < 60]
            if len(self.calls) >= 180:
                return JSONResponse({"error": "Too many requests"}, status_code=429)
            self.calls.append(now)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return response


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
        return JSONResponse({"service": "project-mcp-assistant", "status": "ok"})

    async def status(request):
        s = runtime.settings
        projects = [{"id": p.id, "name": p.name or p.id, "root": str(p.root)}
                    for p in s.projects]
        return JSONResponse({"projects": projects, "sessions": runtime.contexts.list(),
                             "config_id": runtime.config_id,
                             "auth_mode": s.auth_mode, "mcp_port": s.mcp_port,
                             "public_url": s.public_url,
                             "oauth_configured": s.auth_mode == "github",
                             "cloud_account_verified": False,
                             "read_only": True})

    async def action(request: Request):
        try:
            path = request.url.path
            if path == "/api/shutdown" and request.method == "POST":
                runtime.stop_requested.set()
            elif path == "/api/projects" and request.method == "PUT":
                runtime.update_project(await body(request))
            elif path.startswith("/api/projects/") and request.method == "DELETE":
                runtime.remove_project(request.path_params["project_id"])
            elif path == "/api/context" and request.method == "PUT":
                data = await body(request)
                workspace = runtime.workspace(data.get("project_id", ""))
                return JSONResponse(runtime.contexts.put(workspace, data))
            elif path.startswith("/api/context/") and request.method == "DELETE":
                runtime.contexts.delete(request.path_params["session_id"])
            return JSONResponse({"ok": True})
        except PermissionError:
            return JSONResponse({"error": "Path is not allowed"}, status_code=403)
        except (ValueError, TypeError, ValidationError, FileNotFoundError, UnicodeError):
            return JSONResponse({"error": "Invalid request, project or path"}, status_code=400)
        except OSError:
            return JSONResponse({"error": "Local configuration or file unavailable"}, status_code=503)

    async def static(request):
        name = request.path_params.get("name", "index.html")
        if name not in {"index.html", "app.js", "style.css"}:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return FileResponse(STATIC / name)

    app = Starlette(routes=[Route("/", static), Route("/health", health),
        Route("/api/status", status), Route("/api/projects", action, methods=["PUT"]),
        Route("/api/shutdown", action, methods=["POST"]),
        Route("/api/projects/{project_id}", action, methods=["DELETE"]),
        Route("/api/context", action, methods=["PUT"]),
        Route("/api/context/{session_id}", action, methods=["DELETE"]),
        Route("/{name}", static)])
    app.add_middleware(LocalBoundary, token=runtime.settings.admin_token,
                       port=runtime.settings.admin_port)
    return app
