"""Shared test helpers for authenticated API tests."""
from __future__ import annotations

import os

# Fake verifier MUST be selected before any code imports google_verify's cached
# singleton. Tests set this at module import time (same pattern as BUBBLE_FERNET_KEY).
os.environ.setdefault("BUBBLE_FAKE_GOOGLE_VERIFIER", "1")
os.environ.setdefault("BUBBLE_FERNET_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")

from fastapi.testclient import TestClient  # noqa: E402

from backend import db  # noqa: E402
from backend.main import app  # noqa: E402

_TEST_DB_READY = False


def make_client() -> TestClient:
    """TestClient with auth tables initialized."""
    global _TEST_DB_READY
    db.init_db()
    if not _TEST_DB_READY:
        _TEST_DB_READY = True
    return TestClient(app)


def login(client: TestClient, token: str = "valid-token:999:authuser@test.io:verified") -> dict:
    """Authenticate via the fake Google verifier and return auth headers."""
    r = client.post("/api/v1/auth/google", json={"credential": token})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['session_token']}"}


def login_headers(client: TestClient, token: str = "valid-token:999:authuser@test.io:verified") -> dict:
    """Alias kept for readability at call sites."""
    return login(client, token)
