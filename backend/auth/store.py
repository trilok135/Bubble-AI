"""User, identity, and application-session persistence.

Schema design (see docs/google-auth-setup.md):
  users             — one stable Bubble AI identity per person
  auth_identities   — provider logins linked to a user (google "sub", github id, ...)
  app_sessions      — Bubble AI application sessions; stores only SHA-256 token hashes

Identity rules:
  - Google's stable `sub` is the provider identity key (never name/email).
  - Email is unique on users, but linking by email requires email_verified.
"""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from backend.core import security
from backend.core.app_config import settings
from backend.core.errors import AccountConflictError
from backend.db import get_conn

AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS auth_identities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS app_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash_token(token: str) -> str:
    """Sessions store SHA-256 hashes, never raw tokens (DB leak != session leak)."""
    return hashlib.sha256(token.encode()).hexdigest()


def ensure_auth_schema(conn: sqlite3.Connection) -> None:
    """Idempotently create auth tables. Safe on existing dev databases."""
    conn.executescript(AUTH_SCHEMA)


# ---------------------------------------------------------------- users

def get_user_by_email(email: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None


def get_user(user_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_identity(provider: str, provider_subject: str):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM auth_identities WHERE provider = ? AND provider_subject = ?",
            (provider, provider_subject),
        ).fetchone()
        return dict(row) if row else None


def create_user_with_identity(
    *,
    email: str | None,
    name: str | None,
    picture: str | None,
    provider: str,
    provider_subject: str,
) -> dict:
    """Create user + identity + default personalization row atomically."""
    conn = get_conn()
    try:
        conn.execute("BEGIN")
        cur = conn.execute(
            "INSERT INTO users (email, name, picture, created_at, last_login) VALUES (?, ?, ?, ?, ?)",
            (email, name, picture, _now(), _now()),
        )
        user_id = cur.lastrowid
        conn.execute(
            "INSERT INTO auth_identities (user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?)",
            (user_id, provider, provider_subject, _now()),
        )
        # Default personalization profile so user-scoped queries always have a row.
        conn.execute(
            "INSERT OR IGNORE INTO user_profile (user_id, difficulty_preference, struggle_score) VALUES (?, 'medium', 0.0)",
            (str(user_id),),
        )
        conn.commit()
        return user_id  # int
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def link_identity(user_id: int, provider: str, provider_subject: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO auth_identities (user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?)",
            (user_id, provider, provider_subject, _now()),
        )


def touch_last_login(user_id: int) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE users SET last_login = ?, name = COALESCE(?, name), picture = COALESCE(?, picture) WHERE id = ?",
                     (_now(), None, None, user_id))


# ---------------------------------------------------------------- sessions

def create_session(user_id: int) -> tuple[str, str]:
    """Create an application session. Returns (raw_token, expires_at_iso).

    The raw token is returned exactly once; only its SHA-256 hash is stored.
    """
    raw = security.generate_session_token()
    expires = datetime.now(timezone.utc) + timedelta(seconds=settings.SESSION_TTL_SECONDS)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_hash_token(raw), user_id, _now(), expires.isoformat(timespec="seconds")),
        )
    return raw, expires.isoformat(timespec="seconds")


def resolve_session(raw_token: str):
    """Return the session row if the token is valid, unexpired and not revoked."""
    if not raw_token:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM app_sessions WHERE token_hash = ? AND revoked = 0",
            (_hash_token(raw_token),),
        ).fetchone()
        if not row:
            return None
        expires = datetime.fromisoformat(row["expires_at"])
        if datetime.now(timezone.utc) > expires:
            return None
        return dict(row)


def revoke_session(raw_token: str) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE app_sessions SET revoked = 1 WHERE token_hash = ?",
            (_hash_token(raw_token),),
        )
        return cur.rowcount > 0


# ---------------------------------------------------------------- login orchestration

def upsert_google_login(identity) -> int:
    """Find-or-create the Bubble AI user for a VERIFIED external identity.

    Cases:
      1. Identity seen before            -> existing user, update profile fields.
      2. New identity + unused email     -> create user.
      3. New identity + email already    -> ACCOUNT_CONFLICT; requires an explicit
         registered to another user         linking flow. We never auto-link on email.
    """
    existing = get_identity(identity.provider, identity.subject)
    if existing:
        with get_conn() as conn:
            conn.execute(
                "UPDATE users SET name = COALESCE(?, name), picture = COALESCE(?, picture), last_login = ? WHERE id = ?",
                (identity.name, identity.picture, _now(), existing["user_id"]),
            )
        return existing["user_id"]

    # Email-based lookup is only safe for VERIFIED emails.
    email_user = None
    if identity.email and identity.email_verified:
        email_user = get_user_by_email(identity.email)

    if email_user:
        raise AccountConflictError()

    user = create_user_with_identity(
        email=identity.email,
        name=identity.name,
        picture=identity.picture,
        provider=identity.provider,
        provider_subject=identity.subject,
    )
    return user["id"]
