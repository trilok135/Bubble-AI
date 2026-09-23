import json
import logging
from typing import Any, Optional

from pydantic import BaseModel

from .providers.base import AIProvider
from .schemas import MAX_MEMORY_TOKENS, estimate_tokens

logger = logging.getLogger(__name__)

MAX_LIST_ITEMS = 6


class StudyMemory(BaseModel):
    subject: Optional[str] = None
    topic: Optional[str] = None
    user_level: Optional[str] = None
    understood: list[str] = []
    needs_clarification: list[str] = []
    preferred_style: Optional[str] = None

    def compact(self) -> "StudyMemory":
        """Keep only the most recent items so the JSON stays tiny."""
        return StudyMemory(
            subject=self.subject,
            topic=self.topic,
            user_level=self.user_level,
            understood=self.understood[-MAX_LIST_ITEMS:],
            needs_clarification=self.needs_clarification[-MAX_LIST_ITEMS:],
            preferred_style=self.preferred_style,
        )

    def compact_json(self) -> str:
        """Serialized memory guaranteed <= MAX_MEMORY_TOKENS (~300)."""
        data = self.compact().model_dump(exclude_none=True)
        text = json.dumps(data, ensure_ascii=False)
        if estimate_tokens(text) > MAX_MEMORY_TOKENS:
            slim = {
                k: v
                for k, v in data.items()
                if k in ("subject", "topic", "user_level", "preferred_style")
            }
            for k in ("understood", "needs_clarification"):
                if data.get(k):
                    slim[k] = data[k][-3:]
            text = json.dumps(slim, ensure_ascii=False)
        if estimate_tokens(text) > MAX_MEMORY_TOKENS:
            raise ValueError("study memory exceeds token budget")
        return text

    @classmethod
    def from_json(cls, raw: str) -> "StudyMemory":
        try:
            return cls.model_validate(json.loads(raw))
        except Exception:
            return cls()


def _parse_json(raw: str) -> Optional[dict[str, Any]]:
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`").strip()
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None
    return data if isinstance(data, dict) else None


async def compress(
    old_memory: StudyMemory, new_exchange: dict, provider: AIProvider
) -> StudyMemory:
    """Single LLM call that merges a new exchange into the compressed memory."""
    prompt = (
        "You maintain a compact study memory for a student, serialized as JSON with fields:\n"
        "subject (string|null), topic (string|null), user_level (string|null), "
        "understood (list of short strings), needs_clarification (list of short strings), "
        "preferred_style (string|null).\n\n"
        "OLD STUDY MEMORY (JSON):\n"
        f"{old_memory.compact_json()}\n\n"
        "NEW EXCHANGE (JSON):\n"
        f"{json.dumps(new_exchange, ensure_ascii=False)}\n\n"
        "Merge the new exchange into the old memory. Infer the subject/topic, record what the "
        "student now understands, and what still needs clarification (e.g. if the exchange shows "
        "confusion). Keep each list to at most 6 concise items. "
        "Return ONLY the updated JSON object. No prose, no markdown."
    )
    system = "You compress student exchanges into a compact StudyMemory JSON."
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt}
    ]
    try:
        raw = await provider.generate_messages(messages)
    except Exception:
        logger.exception("compress LLM call failed; keeping old memory")
        return old_memory
    parsed = _parse_json(raw)
    if parsed is None:
        logger.warning("compress returned unparseable output; keeping old memory")
        return old_memory
    try:
        return StudyMemory.model_validate(parsed)
    except Exception:
        logger.warning("compress returned invalid StudyMemory JSON; keeping old memory")
        return old_memory
