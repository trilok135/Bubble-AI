import os

os.environ["BUBBLE_FERNET_KEY"] = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
os.environ["BUBBLE_FAKE_GOOGLE_VERIFIER"] = "1"

import pytest
from fastapi.testclient import TestClient

from backend import db
from backend.main import app
from backend.providers.base import AIProvider, ServerError
from backend.tests.helpers import login


def _db_path():
    return db.DB_PATH


class FakeBad(AIProvider):
    name = "gemini"

    def __init__(self):
        super().__init__(api_key="k")
        self.calls = 0

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        raise ServerError("boom")

    async def health_check(self):
        return False


class FakeGood(AIProvider):
    name = "openai"

    def __init__(self):
        super().__init__(api_key="k")
        self.calls = 0

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        return "fake answer text"

    async def health_check(self):
        return True


@pytest.fixture(scope="module")
def client():
    db.init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth(client):
    """Authenticate once per module; return bearer headers."""
    return login(client)


def test_root(client):
    assert client.get("/").json()["status"] == "ok"


def test_new_session_and_memory(client, auth):
    r = client.post("/session/new", json={"subject": "Math", "topic": "Algebra"}, headers=auth)
    assert r.status_code == 200
    sid = r.json()["session_id"]
    m = client.get(f"/session/{sid}/memory", headers=auth)
    assert m.status_code == 200
    assert m.json()["subject"] == "Math"


def test_chat_roundtrip_with_fallback(client, auth):
    app.state.provider_factory = lambda: [FakeBad(), FakeGood()]
    try:
        r = client.post(
            "/chat",
            json={"selected_text": "What is a derivative?", "mode": "explain"},
            headers=auth,
        )
    finally:
        app.state.provider_factory = None
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "fake answer text"
    assert body["provider_used"] == "openai"
    assert body["fell_back"] is True


def test_chat_primary_success(client, auth):
    app.state.provider_factory = lambda: [FakeGood()]
    try:
        r = client.post(
            "/chat",
            json={"selected_text": "Explain photosynthesis", "mode": "explain"},
            headers=auth,
        )
    finally:
        app.state.provider_factory = None
    assert r.status_code == 200
    assert r.json()["fell_back"] is False
    assert r.json()["provider_used"] == "openai"


def test_chat_rejects_budget(client, auth):
    r = client.post(
        "/chat",
        json={"selected_text": "word " * 20000, "mode": "explain"},
        headers=auth,
    )
    assert r.status_code == 422


def test_chat_rejects_unknown_mode(client, auth):
    r = client.post("/chat", json={"selected_text": "x", "mode": "bogus"}, headers=auth)
    assert r.status_code == 422


def test_provider_config_roundtrip_and_encryption(client, auth):
    r = client.post(
        "/providers/config",
        json={"name": "openai", "api_key": "sk-test-secret", "enabled": True, "priority": 1},
        headers=auth,
    )
    assert r.status_code == 200
    r = client.get("/providers/config", headers=auth)
    entry = [x for x in r.json() if x["name"] == "openai"][0]
    assert entry["has_key"] is True
    assert entry["enabled"] is True
    assert entry["priority"] == 1

    rows = db.list_provider_config()
    row = [x for x in rows if x["name"] == "openai"][0]
    assert "sk-test-secret" not in row["api_key_encrypted"]


class SmartProvider(AIProvider):
    name = "openai"

    def __init__(self):
        super().__init__(api_key="k")
        self.calls = 0

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        if "Merge the new exchange into the old memory" in messages[-1]['content']:
            return (
                '{"subject": "Math", "topic": "Calculus", "user_level": "beginner",'
                ' "understood": ["derivatives"], "needs_clarification": ["limits"]}'
            )
        return "answer text"

    async def health_check(self):
        return True


def test_auto_compress_after_five_exchanges(client, auth):
    app.state.provider_factory = lambda: [SmartProvider()]
    try:
        sid = client.post("/session/new", json={"subject": "Math"}, headers=auth).json()["session_id"]
        for _ in range(5):
            r = client.post(
                "/chat",
                json={"selected_text": "Explain derivative", "mode": "explain", "session_id": sid},
                headers=auth,
            )
            assert r.status_code == 200
    finally:
        app.state.provider_factory = None
    mem = client.get(f"/session/{sid}/memory", headers=auth).json()
    assert mem["topic"] == "Calculus"
    assert mem["understood"] == ["derivatives"]
    assert mem["needs_clarification"] == ["limits"]


def test_manual_compress_endpoint(client, auth):
    app.state.provider_factory = lambda: [SmartProvider()]
    try:
        sid = client.post("/session/new", json={"subject": "Chem"}, headers=auth).json()["session_id"]
        client.post(
            "/chat",
            json={"selected_text": "Bonds", "mode": "explain", "session_id": sid},
            headers=auth,
        )
        r = client.post(f"/session/{sid}/compress", json={"force": True}, headers=auth)
        assert r.status_code == 200
        assert r.json()["topic"] == "Calculus"
    finally:
        app.state.provider_factory = None


def test_usage_counts(client, auth):
    app.state.provider_factory = lambda: [SmartProvider()]
    try:
        sid = client.post("/session/new", json={}, headers=auth).json()["session_id"]
        for _ in range(3):
            client.post(
                "/chat",
                json={"selected_text": "q", "mode": "explain", "session_id": sid},
                headers=auth,
            )
        status = client.get("/providers/status", headers=auth).json()
        entry = [s for s in status if s["name"] == "openai"]
        assert entry and entry[0]["requests_today"] >= 3
    finally:
        app.state.provider_factory = None
