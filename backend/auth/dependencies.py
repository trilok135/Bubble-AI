"""FastAPI authentication dependencies.

`get_current_user` extracts the Bearer token from the Authorization header,
resolves it against app_sessions, and returns the user dict. All protected
routes use `user=Depends(get_current_user)` instead of inline checks.

Error contract on failure:
  401 {"error": {"code": "AUTH_REQUIRED",    ...}}  — no/missing token
  401 {"error": {"code": "SESSION_INVALID",  ...}}  — unknown/expired/revoked token
"""
from __future__ import annotations

import os

from fastapi import Depends, Request

from backend.auth import store
from backend.core.app_config import settings
from backend.core.errors import AuthRequiredError, SessionInvalidError


def _extract_bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if not auth:
        return None
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        return None
    return parts[1].strip()


def get_current_user(request: Request) -> dict:
    token = _extract_bearer_token(request)
    if not token:
        raise AuthRequiredError()
    session = store.resolve_session(token)
    if not session:
        # Covers unknown tokens AND expired ones; SESSION_INVALID tells clients
        # to sign in again rather than retry (SESSION_EXPIRED is kept for the
        # contract but not distinguishable without leaking timing info).
        raise SessionInvalidError()
    user = store.get_user(session["user_id"])
    if not user:
        raise SessionInvalidError()
    user = dict(user)
    user["session_id_internal"] = session["id"]
    user["session_token"] = token
    return user


def get_optional_user(request: Request):
    """Like get_current_user but returns None instead of raising.

    Used by endpoints that work for both anonymous and authenticated users
    during the migration window (e.g. legacy chat clients).
    """
    token = _extract_bearer_token(request)
    if not token:
        return None
    session = store.resolve_session(token)
    if not session:
        return None
    return store.get_user(session["user_id"])


def get_admin_user(user: dict = Depends(get_current_user)) -> dict:
    """Guard for provider-administration endpoints (/providers/*).

    Production: requires the authenticated user's email to be listed in
    BUBBLE_ADMIN_EMAILS (comma-separated). Development: any authenticated
    user may manage providers (single-user dev server) — this keeps the
    local workflow and existing tests simple while production is locked.
    """
    if settings.is_production:
        raw = os.environ.get("BUBBLE_ADMIN_EMAILS", "")
        admins = {e.strip().lower() for e in raw.split(",") if e.strip()}
        if (user.get("email") or "").lower() not in admins:
            from backend.core.errors import BubbleError
            raise BubbleError("Provider administration requires an admin account.",
                              code="FORBIDDEN", status_code=403)
    return user
