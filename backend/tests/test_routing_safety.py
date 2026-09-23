import os

os.environ.setdefault("BUBBLE_FAKE_GOOGLE_VERIFIER", "1")

import pytest
from fastapi.testclient import TestClient

from backend.main import app, get_routing_order, MAX_INPUT_LENGTH
from backend.providers.base import AIProvider, OutageError, RateLimitError, ServerError
from backend.providers.gemini_provider import GeminiProvider
from backend.providers.groq_provider import GroqProvider
from backend.router import AIRouter
from backend.tests.helpers import login


class MockSuccessProvider(AIProvider):
    def __init__(self, name: str):
        super().__init__(api_key="mock_key")
        self.name = name

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        return f"Response from {self.name}"

    async def health_check(self) -> bool:
        return True


class MockFailingProvider(AIProvider):
    def __init__(self, name: str, exc: Exception):
        super().__init__(api_key="mock_key")
        self.name = name
        self.exc = exc

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        raise self.exc

    async def health_check(self) -> bool:
        return False


def test_mode_based_routing_order():
    providers = [MockSuccessProvider("groq"), MockSuccessProvider("gemini")]

    # Explain -> Groq primary
    order_explain = get_routing_order("explain", providers)
    assert order_explain == ["groq", "gemini"]

    # Notes -> Groq primary
    order_notes = get_routing_order("notes", providers)
    assert order_notes == ["groq", "gemini"]

    # Quiz -> Gemini primary
    order_quiz = get_routing_order("quiz", providers)
    assert order_quiz == ["gemini", "groq"]

    # Exam -> Gemini primary
    order_exam = get_routing_order("exam", providers)
    assert order_exam == ["gemini", "groq"]


async def test_fallback_from_primary_to_secondary():
    failing_groq = MockFailingProvider("groq", RateLimitError("Groq 429 Rate Limit"))
    working_gemini = MockSuccessProvider("gemini")

    router = AIRouter([failing_groq, working_gemini], ["groq", "gemini"])
    res = await router.route([{'role': 'user', 'content': 'Hello'}], 'Explain')
    assert res.provider_used == "gemini"
    assert res.fell_back is True
    assert res.text == "Response from gemini"


async def test_fallback_from_gemini_to_groq_for_quiz():
    failing_gemini = MockFailingProvider("gemini", ServerError("Gemini 500 Error"))
    working_groq = MockSuccessProvider("groq")

    router = AIRouter([failing_gemini, working_groq], ["gemini", "groq"])
    res = await router.route([{'role': 'user', 'content': 'Generate quiz'}], 'Quiz')
    assert res.provider_used == "groq"
    assert res.fell_back is True
    assert res.text == "Response from groq"


def test_input_length_limit_exceeded():
    client = TestClient(app)
    auth = login(client)
    long_text = "A" * (MAX_INPUT_LENGTH + 10)
    response = client.post("/chat", json={"mode": "explain", "selected_text": long_text}, headers=auth)
    assert response.status_code == 400
    assert "exceeds maximum allowed length" in response.json()["detail"]


def test_both_providers_fail_returns_503():
    app.state.provider_factory = lambda: [
        MockFailingProvider("groq", RateLimitError("Groq quota limit")),
        MockFailingProvider("gemini", ServerError("Gemini internal error")),
    ]
    client = TestClient(app)
    auth = login(client)
    try:
        response = client.post("/chat", json={"mode": "explain", "selected_text": "Explain quantum computing"}, headers=auth)
        assert response.status_code == 503
        assert "Service temporarily unavailable" in response.json()["detail"]
    finally:
        app.state.provider_factory = None
