from typing import Optional

from pydantic import BaseModel, field_validator

MODES = [
    "explain",
    "simple_explain",
    "example",
    "code_explain",
    "2mark",
    "longform",
    "quiz_me",
    "make_notes",
]

MAX_SELECTED_TEXT_TOKENS = 1500
MAX_MEMORY_TOKENS = 300


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~1 token per word plus punctuation overhead."""
    if not text:
        return 0
    words = text.split()
    letters = sum(len(w) for w in words)
    return len(words) + max(0, len(text) - letters) // 6


class ChatRequest(BaseModel):
    selected_text: str
    mode: str
    session_id: Optional[int] = None
    subject: Optional[str] = None
    topic: Optional[str] = None

    @field_validator("mode")
    @classmethod
    def _mode_valid(cls, v: str) -> str:
        if v not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        return v

    @field_validator("selected_text")
    @classmethod
    def _budget_valid(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("selected_text must not be empty")
        if estimate_tokens(v) > MAX_SELECTED_TEXT_TOKENS:
            raise ValueError(
                f"selected_text exceeds token budget ({MAX_SELECTED_TEXT_TOKENS})"
            )
        return v


class NewSessionRequest(BaseModel):
    subject: Optional[str] = None
    topic: Optional[str] = None


class ProviderConfigRequest(BaseModel):
    name: str
    api_key: Optional[str] = None
    enabled: bool = True
    priority: int = 100


class ProviderConfigView(BaseModel):
    name: str
    has_key: bool
    enabled: bool
    priority: int


class ProviderStatus(BaseModel):
    name: str
    healthy: bool
    requests_today: int


class CompressRequest(BaseModel):
    force: bool = True
