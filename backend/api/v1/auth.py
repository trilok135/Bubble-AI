"""Bubble AI authentication router.

Endpoints (paths preserved from the existing implementation):
  POST /api/v1/auth/session   — legacy anonymous session bootstrap (kept for compat)
  POST /api/v1/auth/google    — Google ID token -> verified identity -> Bubble session
  POST /api/v1/auth/github    — GitHub OAuth code -> identity -> Bubble session
  POST /api/v1/auth/logout    — revoke the caller's Bubble session
  GET  /api/v1/auth/me        — whoami for session restore
  GET  /api/v1/auth/config    — public config for login pages (client id only)
"""
from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from backend.auth import store
from backend.auth.dependencies import get_current_user
from backend.auth.google_verify import GoogleIdentity, get_google_verifier
from backend.core.app_config import settings
from backend.core.errors import (
    AccountConflictError,
    GoogleTokenError,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class SessionCreateResponse(BaseModel):
    authenticated: bool = True
    session_token: str
    expires_at: str | None = None
    message: str
    user: dict | None = None


class GoogleAuthRequest(BaseModel):
    """Accepts both `credential` (GIS convention) and `token` (legacy extension)."""
    credential: str | None = None
    token: str | None = None


class GithubAuthRequest(BaseModel):
    code: str


class LogoutRequest(BaseModel):
    session_token: str | None = None


def _public_user(user: dict) -> dict:
    """Whitelist projection — never leak internal columns."""
    return {
        "id": str(user["id"]),
        "email": user.get("email"),
        "name": user.get("name"),
        "picture": user.get("picture"),
    }


def _anonymous_user_id() -> int:
    """Get-or-create the shared anonymous user used by the legacy flow."""
    user = store.get_user_by_email("anonymous@bubble.local")
    if user:
        return user["id"]
    return store.create_user_with_identity(
        email="anonymous@bubble.local",
        name="Anonymous",
        picture=None,
        provider="anonymous",
        provider_subject="anonymous",
    )


@router.post("/session", response_model=SessionCreateResponse)
async def create_session():
    """Legacy anonymous session bootstrap. Kept for existing clients."""
    uid = _anonymous_user_id()
    raw, expires = store.create_session(uid)
    return SessionCreateResponse(
        session_token=raw,
        expires_at=expires,
        message="Session created successfully",
        user=_public_user(store.get_user(uid)),
    )


@router.post("/google", response_model=SessionCreateResponse)
async def google_auth(req: GoogleAuthRequest):
    """Google login: verify ID token server-side, then find-or-create the user.

    The client sends {"credential": "<GOOGLE_ID_TOKEN>"} (GIS convention) or
    {"token": "<GOOGLE_ID_TOKEN>"} (legacy extension field). Both are the ID
    token — the previous access-token flow is replaced by verification.
    """
    id_token = (req.credential or req.token or "").strip()
    if not id_token:
        raise GoogleTokenError(message="Missing Google credential.")

    identity = get_google_verifier().verify(id_token)

    # May raise AccountConflictError (409) -> handled by the global handler.
    user_id = store.upsert_google_login(identity)
    user = store.get_user(user_id)

    raw_token, expires = store.create_session(user_id)
    return SessionCreateResponse(
        session_token=raw_token,
        expires_at=expires,
        message="Session created",
        user=_public_user(user),
    )


@router.post("/github", response_model=SessionCreateResponse)
async def github_auth(req: GithubAuthRequest):
    """GitHub OAuth code -> identity -> same user/session architecture.

    Identity linking uses provider='github', subject = numeric GitHub user id.
    """
    github_secret = os.environ.get("GITHUB_CLIENT_SECRET")
    github_client_id = os.environ.get("GITHUB_CLIENT_ID", "<YOUR_GITHUB_CLIENT_ID>")

    if not github_secret or github_secret == "<YOUR_GITHUB_CLIENT_SECRET>":
        # Mock for local testing when unconfigured (existing behavior preserved).
        # Find-or-create via the identity system so repeat logins reuse the user.
        mock_identity = GoogleIdentity(
            provider="github", subject="mock-github", email="github_mock@bubble.ai",
            email_verified=True, name="GitHub Mock", picture=None,
        )
        uid = store.upsert_google_login(mock_identity)
        raw_token, expires = store.create_session(uid)
        return SessionCreateResponse(
            session_token=raw_token, expires_at=expires,
            message="Mock session created", user=_public_user(store.get_user(uid)),
        )

    async with httpx.AsyncClient() as client:
        token_res = await client.post(
            "https://github.com/login/oauth/access_token",
            json={"client_id": github_client_id, "client_secret": github_secret, "code": req.code},
            headers={"Accept": "application/json"},
        )
        if token_res.status_code != 200:
            raise GoogleTokenError(message="Failed to exchange GitHub code.")
        token_data = token_res.json()
        access_token = token_data.get("access_token")
        if not access_token:
            raise GoogleTokenError(message="Invalid GitHub code.")

        user_res = await client.get(
            "https://api.github.com/user",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        emails_res = await client.get(
            "https://api.github.com/user/emails",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_res.status_code != 200:
            raise GoogleTokenError(message="Failed to fetch GitHub user.")

        gh = user_res.json()
        gh_subject = str(gh.get("id", ""))  # stable GitHub user id = provider subject
        emails = emails_res.json() if emails_res.status_code == 200 else []
        primary = next((e for e in emails if e.get("primary")), None)
        email = (primary or {}).get("email") or gh.get("email")
        email_verified = bool((primary or {}).get("verified", False))

    identity = GoogleIdentity(
        provider="github",
        subject=gh_subject,
        email=email,
        email_verified=email_verified,
        name=gh.get("name") or gh.get("login"),
        picture=gh.get("avatar_url"),
    )
    uid = store.upsert_google_login(identity)  # shared identity orchestration
    raw_token, expires = store.create_session(uid)
    return SessionCreateResponse(
        session_token=raw_token, expires_at=expires,
        message="Session created", user=_public_user(store.get_user(uid)),
    )


@router.post("/logout")
async def logout(request: Request, req: LogoutRequest | None = None, user: dict = Depends(get_current_user)):
    """Revoke the caller's Bubble session. Google sign-out is a client concern
    and is deliberately NOT performed here."""
    token = None
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
    elif req and req.session_token:
        token = req.session_token
    if token:
        store.revoke_session(token)
    return {"authenticated": False, "message": "Logged out successfully"}


@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    """Session restore: returns the authenticated Bubble AI user."""
    return {"authenticated": True, "user": _public_user(user)}


@router.get("/config")
async def auth_config():
    """Public, non-secret config for login pages: the Google client ID.

    The client ID is public by design; no secrets are exposed here.
    """
    return {
        "google_client_id": settings.GOOGLE_CLIENT_ID or None,
        "session_ttl_seconds": settings.SESSION_TTL_SECONDS,
    }
