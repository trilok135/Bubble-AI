import pytest

from backend.memory import StudyMemory, compress
from backend.providers.base import AIProvider
from backend.schemas import MAX_MEMORY_TOKENS, estimate_tokens


class EchoProvider(AIProvider):
    name = "echo"

    def __init__(self, response):
        super().__init__(api_key="k")
        self.response = response
        self.last_prompt = ""

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        self.last_prompt = messages[-1]['content']
        return self.response

    async def health_check(self):
        return True


def test_compact_json_respects_budget():
    m = StudyMemory(
        subject="Computer Science",
        topic="Data Structures",
        understood=["a"] * 20,
        needs_clarification=["b"] * 20,
        preferred_style="visual",
    )
    j = m.compact_json()
    assert estimate_tokens(j) <= MAX_MEMORY_TOKENS
    parsed = StudyMemory.from_json(j)
    assert len(parsed.understood) <= 6


def test_compact_keeps_identity_fields():
    m = StudyMemory(subject="Physics", topic="Waves")
    j = m.compact_json()
    parsed = StudyMemory.from_json(j)
    assert parsed.subject == "Physics"
    assert parsed.topic == "Waves"


def test_from_json_tolerates_garbage():
    m = StudyMemory.from_json("not json at all")
    assert m.subject is None
    assert m.understood == []


async def test_compress_parses_fenced_json():
    payload = '```json\n{"subject": "Physics", "topic": "Waves", "user_level": "beginner", "understood": ["amplitude"], "needs_clarification": ["phase"]}\n```'
    p = EchoProvider(payload)
    old = StudyMemory(subject="Physics")
    out = await compress(old, {"mode": "explain", "selected_text": "what is amplitude", "answer": "..."}, p)
    assert out.subject == "Physics"
    assert out.topic == "Waves"
    assert out.understood == ["amplitude"]
    assert out.needs_clarification == ["phase"]


async def test_compress_keeps_old_on_bad_json():
    p = EchoProvider("no json here")
    old = StudyMemory(subject="Keep")
    out = await compress(old, {"mode": "explain"}, p)
    assert out.subject == "Keep"


async def test_compress_keeps_old_on_llm_failure():
    class Boom(AIProvider):
        name = "boom"

        def __init__(self):
            super().__init__(api_key="k")

        async def generate_messages(self, messages: list[dict[str, str]]) -> str:
            raise RuntimeError("network down")

        async def health_check(self):
            return False

    old = StudyMemory(subject="Keep")
    out = await compress(old, {"mode": "explain"}, Boom())
    assert out.subject == "Keep"
