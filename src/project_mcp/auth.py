"""Authenticate with maintained providers and restrict OAuth to the configured owner."""
import os

from cryptography.fernet import Fernet
from fastmcp.server.auth.jwt_issuer import derive_jwt_key
from fastmcp.server.auth.providers.github import GitHubProvider
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from fastmcp.server.dependencies import get_access_token
from key_value.aio.stores.filetree import FileTreeStore, FileTreeV1KeySanitizationStrategy
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper


def encrypted_store(directory, secret):
    key = derive_jwt_key(high_entropy_material=secret, salt="project-mcp-storage")
    # CIMD client IDs are URLs, which cannot be used directly as Windows filenames.
    store = FileTreeStore(data_directory=directory,
                         key_sanitization_strategy=FileTreeV1KeySanitizationStrategy(directory))
    return FernetEncryptionWrapper(key_value=store,
                                   fernet=Fernet(key), raise_on_decryption_error=False)


class OwnerGitHubProvider(GitHubProvider):
    def __init__(self, *, owner_ids: list[str], health=None, **kwargs):
        if not owner_ids:
            raise ValueError("At least one GitHub owner ID is required")
        self.owner_ids = frozenset(owner_ids)
        self.health = health
        super().__init__(**kwargs)

    async def load_access_token(self, token):
        verified = await super().load_access_token(token)
        if verified and str(verified.claims.get("sub", "")) in self.owner_ids:
            if self.health:
                self.health.record("oauth", "ok")
            return verified.model_copy(update={
                "scopes": sorted({*verified.scopes, "project:read", "project:propose"}),
            })
        if self.health:
            self.health.record("oauth", "failed", "AUTH_REQUIRED", retryable=True)
        return None


def current_actor_id(required_scope: str) -> str:
    """Derive the actor only from FastMCP's verified request context."""
    token = get_access_token()
    if token is None:
        raise PermissionError("AUTH_REQUIRED: authenticated actor is required")
    if required_scope not in set(token.scopes):
        raise PermissionError("PROJECT_FORBIDDEN: authenticated actor lacks capability")
    actor = str(token.claims.get("sub") or token.subject or token.client_id).strip()
    if not actor or len(actor) > 200:
        raise PermissionError("AUTH_REQUIRED: authenticated actor is invalid")
    return actor


def build_auth(settings, health=None):
    if settings.auth_mode == "local":
        if len(settings.mcp_token) < 32:
            raise ValueError("Initialize local credentials before starting")
        return StaticTokenVerifier(tokens={settings.mcp_token: {
            "client_id": "local-development",
            "scopes": ["project:read", "project:propose"],
        }})
    client_id = os.environ.get("PROJECT_MCP_GITHUB_CLIENT_ID", "")
    client_secret = os.environ.get("PROJECT_MCP_GITHUB_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise ValueError("Set PROJECT_MCP_GITHUB_CLIENT_ID and PROJECT_MCP_GITHUB_CLIENT_SECRET")
    return OwnerGitHubProvider(
        owner_ids=settings.github_user_ids, health=health,
        client_id=client_id, client_secret=client_secret,
        base_url=settings.public_url, required_scopes=["read:user"],
        client_storage=encrypted_store(settings.state_dir / "oauth", client_secret),
        require_authorization_consent=True,
    )
