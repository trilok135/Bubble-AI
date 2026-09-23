import pytest

from backend.providers.base import (
    AIProvider,
    AuthError,
    InvalidRequestError,
    OutageError,
    RateLimitError,
    ServerError,
)
from backend.router import AIRouter


class FakeProvider(AIProvider):
    def __init__(self, name, exc=None, text="answer"):
        super().__init__(api_key="k")
        self.name = name
        self.exc = exc
        self.text = text
        self.calls = 0

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.text

    async def health_check(self):
        return True


async def test_primary_success_no_fallback():
    p = FakeProvider("p1")
    r = await AIRouter([p], ["p1"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert r.provider_used == "p1"
    assert r.fell_back is False
    assert r.text == "answer"


async def test_fallback_on_server_error():
    bad = FakeProvider("p1", exc=ServerError("boom"))
    good = FakeProvider("p2")
    r = await AIRouter([bad, good], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert r.provider_used == "p2"
    assert r.fell_back is True
    assert good.calls == 1


async def test_fallback_on_rate_limit():
    bad = FakeProvider("p1", exc=RateLimitError("rl"))
    good = FakeProvider("p2")
    r = await AIRouter([bad, good], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert r.provider_used == "p2"
    assert r.fell_back is True


async def test_fallback_on_outage():
    bad = FakeProvider("p1", exc=OutageError("down"))
    good = FakeProvider("p2")
    r = await AIRouter([bad, good], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert r.provider_used == "p2"
    assert r.fell_back is True


async def test_no_fallback_on_auth_error():
    bad = FakeProvider("p1", exc=AuthError("nope"))
    good = FakeProvider("p2")
    with pytest.raises(AuthError):
        await AIRouter([bad, good], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert good.calls == 0


async def test_no_fallback_on_invalid_request():
    bad = FakeProvider("p1", exc=InvalidRequestError("bad"))
    good = FakeProvider("p2")
    with pytest.raises(InvalidRequestError):
        await AIRouter([bad, good], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')
    assert good.calls == 0


async def test_all_fail_raises():
    a = FakeProvider("p1", exc=ServerError("x"))
    b = FakeProvider("p2", exc=OutageError("y"))
    with pytest.raises(OutageError):
        await AIRouter([a, b], ["p1", "p2"]).route([{'role': 'user', 'content': 'q'}], 'Explain')


async def test_no_providers_raises():
    with pytest.raises(OutageError):
        await AIRouter([], []).route([{'role': 'user', 'content': 'q'}], 'Explain')
