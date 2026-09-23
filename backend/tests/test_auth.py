"""Authentication test suite.

Covers: Google token verification (via FakeGoogleVerifier), user creation,
account conflicts, sessions, /me, /logout, and cross-user authorization.
Real Google verification is exercised separately when credentials exist
(see docs/google-auth-setup.md § Testing with real Google credentials).
"""
import os

os.environ["BUBBLE_FERNET_KEY"] = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
os.environ["BUBBLE_FAKE_GOOGLE_VERIFIER"] = "1"

import pytest
from fastapi.testclient import TestClient

from backend import db
from backend.main import app
from backend.tests.helpers import make_client, login

# ------------------------------------------------------------------ token verification


@pytest.fixture(scope="module")
def client():
    db.init_db()
    with TestClient(app) as c:
        yield c


def test_valid_google_credential_returns_session(client):
    r = client.post("/api/v1/auth/google", json={"credential": "valid-token:g1:alice@test.io:verified"})
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is True
    assert body["session_token"]
    assert body["user"]["email"] == "alice@test.io"
    assert body["user"]["id"]


def test_missing_credential_rejected(client):
    r = client.post("/api/v1/auth/google", json={})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_GOOGLE_TOKEN"


def test_invalid_credential_rejected(client):
    r = client.post("/api/v1/auth/google", json={"credential": "garbage-token"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_GOOGLE_TOKEN"


def test_expired_credential_rejected(client):
    # FakeGoogleVerifier treats unknown prefixes as invalid; a real-expiry case
    # is covered by GoogleVerifier unit tests with PyJWT (below).
    r = client.post("/api/v1/auth/google", json={"credential": "expired-token:x:y@z.io"})
    assert r.status_code == 401


def test_legacy_token_field_accepted(client):
    """Existing extension sends {"token": ...}; must keep working."""
    r = client.post("/api/v1/auth/google", json={"token": "valid-token:g-legacy:legacy@test.io:verified"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "legacy@test.io"


# ------------------------------------------------------------------ users


def test_existing_google_user_same_account(client):
    """Same Google sub twice -> same Bubble AI user id (no duplicate)."""
    a = client.post("/api/v1/auth/google", json={"credential": "valid-token:sub-dup:dup@test.io:verified"}).json()
    b = client.post("/api/v1/auth/google", json={"credential": "valid-token:sub-dup:dup@test.io:verified"}).json()
    assert a["user"]["id"] == b["user"]["id"]


def test_account_conflict_on_email_registered_elsewhere(client):
    """Google identity is new but its verified email already belongs to an
    account created via another provider -> ACCOUNT_CONFLICT, no auto-link."""
    # Create a GitHub-mocked user first (shares the users table).
    client.post("/api/v1/auth/github", json={"code": "anything"})
    # github_mock@bubble.ai now exists, owned by the GitHub mock identity.
    r = client.post("/api/v1/auth/google", json={"credential": "conflict-token:g-conf:github_mock@bubble.ai:verified"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "ACCOUNT_CONFLICT"


# ------------------------------------------------------------------ sessions


def test_me_requires_auth(client):
    r = client.get("/api/v1/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "AUTH_REQUIRED"


def test_me_with_valid_session(client):
    headers = login(client, "valid-token:g-me:me@test.io:verified")
    r = client.get("/api/v1/auth/me", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is True
    assert body["user"]["email"] == "me@test.io"
    assert "session_token" not in body["user"]  # never echo tokens


def test_me_with_invalid_session(client):
    r = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "SESSION_INVALID"


def test_logout_revokes_session(client):
    headers = login(client, "valid-token:g-out:out@test.io:verified")
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    r = client.post("/api/v1/auth/logout", headers=headers)
    assert r.status_code == 200
    # Token is now revoked — even though it was valid moments ago.
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def test_expired_session_rejected(client):
    """A session row with a past expiry must fail resolution."""
    from backend.auth import store
    from datetime import datetime, timedelta, timezone
    from backend.tests.helpers import login as _login

    headers = _login(client, "valid-token:g-exp:exp@test.io:verified")
    # Force-expire every session for this user directly in the DB.
    raw_token = headers["Authorization"].split(" ", 1)[1]
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE app_sessions SET expires_at = ? WHERE token_hash = ?",
            ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds"),
             __import__("hashlib").sha256(raw_token.encode()).hexdigest()),
        )
    r = client.get("/api/v1/auth/me", headers=headers)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "SESSION_INVALID"


def test_auth_config_exposes_client_id_only(client):
    r = client.get("/api/v1/auth/config")
    assert r.status_code == 200
    body = r.json()
    assert "session_ttl_seconds" in body
    assert "secret" not in str(body).lower() or body.get("google_client_id") is None


# ------------------------------------------------------------------ real crypto verification
# GoogleVerifier is exercised with genuinely signed RS256 tokens: we generate an
# RSA key, sign JWTs with PyJWT, and stub only the JWKS fetch. Signature,
# issuer, audience, and expiry checks therefore run for real — no network.


def _make_verifier(monkeypatch):
    """GoogleVerifier wired to a local RSA keypair; returns (verifier, private_key)."""
    from cryptography.hazmat.primitives.asymmetric import rsa
    from backend.auth.google_verify import GoogleVerifier

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    v = GoogleVerifier(client_id="test-client-id")

    class FakeJwkClient:
        def get_signing_key_from_jwt(self, token):
            class FakeSigningKey:
                pass
            sk = FakeSigningKey()
            sk.key = key.public_key()
            return sk

    monkeypatch.setattr(v, "_jwk_client", FakeJwkClient())
    return v, key


def _sign(key, claims):
    import jwt
    from cryptography.hazmat.primitives import serialization
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256")


def _base_claims():
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    return {
        "iss": "https://accounts.google.com",
        "aud": "test-client-id",
        "sub": "google-sub-123",
        "email": "real@test.io",
        "email_verified": True,
        "name": "Real User",
        "iat": now,
        "exp": now + timedelta(hours=1),
    }


def test_real_verifier_accepts_valid_rs256_token(monkeypatch):
    v, key = _make_verifier(monkeypatch)
    identity = v.verify(_sign(key, _base_claims()))
    assert identity.provider == "google"
    assert identity.subject == "google-sub-123"
    assert identity.email == "real@test.io"
    assert identity.email_verified is True


def test_real_verifier_rejects_wrong_signature(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric import rsa
    v, _ = _make_verifier(monkeypatch)
    signer = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # not the JWKS key
    with pytest.raises(Exception) as ei:
        v.verify(_sign(signer, _base_claims()))
    assert ei.value.code == "INVALID_GOOGLE_TOKEN"


def test_real_verifier_rejects_expired_token(monkeypatch):
    from datetime import datetime, timedelta, timezone
    v, key = _make_verifier(monkeypatch)
    claims = _base_claims()
    claims["exp"] = datetime.now(timezone.utc) - timedelta(hours=2)
    with pytest.raises(Exception) as ei:
        v.verify(_sign(key, claims))
    assert ei.value.code == "GOOGLE_TOKEN_EXPIRED"


def test_real_verifier_rejects_wrong_audience(monkeypatch):
    v, key = _make_verifier(monkeypatch)
    claims = _base_claims()
    claims["aud"] = "someone-elses-client-id"
    with pytest.raises(Exception) as ei:
        v.verify(_sign(key, claims))
    assert ei.value.code == "GOOGLE_AUDIENCE_MISMATCH"


def test_real_verifier_rejects_wrong_issuer(monkeypatch):
    v, key = _make_verifier(monkeypatch)
    claims = _base_claims()
    claims["iss"] = "https://evil.example.com"
    with pytest.raises(Exception) as ei:
        v.verify(_sign(key, claims))
    assert ei.value.code == "GOOGLE_ISSUER_INVALID"


# ------------------------------------------------------------------ authorization


def test_chat_requires_auth(client):
    r = client.post("/api/v1/chat", json={"message": "hi", "mode": "Explain"})
    assert r.status_code == 401


def test_unauthenticated_cannot_read_conversations(client):
    r = client.get("/api/v1/conversations")
    assert r.status_code == 401


def test_user_cannot_access_other_users_session(client):
    """User A cannot post chat into User B's session (404, ownership)."""
    ha = login(client, "valid-token:g-a:a@test.io:verified")
    hb = login(client, "valid-token:g-b:b@test.io:verified")

    app.state.provider_factory = lambda: []
    # Create B's session via /session/new (legacy route, also auth-guarded).
    sid_b = client.post("/session/new", json={"subject": "B-topic"}, headers=hb).json()["session_id"]
    r = client.post(
        "/api/v1/chat",
        json={"message": "sneaky", "mode": "Explain", "session_id": sid_b},
        headers=ha,
    )
    assert r.status_code == 404  # exists, but not yours

    # A's own new session works (no providers configured -> 400, but auth passed).
    r2 = client.post("/api/v1/chat", json={"message": "mine", "mode": "Explain"}, headers=ha)
    assert r2.status_code == 400  # reached business logic ("no providers configured")
    assert "providers" in r2.json()["detail"]


def test_user_cannot_read_other_users_conversation(client):
    ha = login(client, "valid-token:g-c:c@test.io:verified")
    hb = login(client, "valid-token:g-d:d@test.io:verified")
    sid_b = client.post("/session/new", json={"subject": "B-private"}, headers=hb).json()["session_id"]
    assert client.get(f"/api/v1/conversations/{sid_b}", headers=ha).status_code == 404
    assert client.get(f"/api/v1/conversations/{sid_b}", headers=hb).status_code == 200


def test_user_cannot_delete_other_users_conversation(client):
    ha = login(client, "valid-token:g-e:e@test.io:verified")
    hb = login(client, "valid-token:g-f:f@test.io:verified")
    sid_b = client.post("/session/new", json={}, headers=hb).json()["session_id"]
    assert client.delete(f"/api/v1/conversations/{sid_b}", headers=ha).status_code == 404
    assert client.delete(f"/api/v1/conversations/{sid_b}", headers=hb).status_code == 200


def test_memory_deletion_scoped_to_user(client):
    """Deleting memory must not touch other users' memory rows."""
    ha = login(client, "valid-token:g-g:g@test.io:verified")
    hb = login(client, "valid-token:g-h:h@test.io:verified")

    from backend import db as bdb
    from backend.memory import StudyMemory

    sid_a = client.post("/session/new", json={}, headers=ha).json()["session_id"]
    sid_b = client.post("/session/new", json={}, headers=hb).json()["session_id"]
    bdb.save_memory(sid_a, StudyMemory(subject="A-data"))
    bdb.save_memory(sid_b, StudyMemory(subject="B-data"))

    client.delete("/api/v1/memory", headers=ha)
    assert bdb.load_memory(sid_a) is None
    assert bdb.load_memory(sid_b) is not None  # B untouched


def test_providers_admin_protected_from_anonymous(client):
    r = client.get("/providers/config")
    assert r.status_code == 401
    r = client.post("/providers/config", json={"name": "groq", "api_key": "x", "enabled": True, "priority": 1})
    assert r.status_code == 401


def test_legacy_session_new_requires_auth(client):
    r = client.post("/session/new", json={})
    assert r.status_code == 401


# ------------------------------------------------------------------ persistence across re-login


def test_data_survives_logout_and_relogin(client):
    """Sign out, sign back in with the same identity -> same account id,
    conversations retained."""
    h1 = login(client, "valid-token:g-persist:p@test.io:verified")
    uid_before = client.get("/api/v1/auth/me", headers=h1).json()["user"]["id"]
    sid = client.post("/session/new", json={"subject": "Persisted"}, headers=h1).json()["session_id"]
    client.post("/api/v1/auth/logout", headers=h1)

    h2 = login(client, "valid-token:g-persist:p@test.io:verified")
    uid_after = client.get("/api/v1/auth/me", headers=h2).json()["user"]["id"]
    assert uid_after == uid_before

    convs = client.get("/api/v1/conversations", headers=h2).json()["conversations"]
    assert any(c["id"] == sid for c in convs)
