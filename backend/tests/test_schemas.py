import pytest
from pydantic import ValidationError

from backend.schemas import ChatRequest, estimate_tokens


def test_rejects_empty_text():
    with pytest.raises(ValidationError):
        ChatRequest(selected_text="   ", mode="explain")


def test_rejects_huge_text_budget():
    with pytest.raises(ValidationError):
        ChatRequest(selected_text="word " * 20000, mode="explain")


def test_rejects_unknown_mode():
    with pytest.raises(ValidationError):
        ChatRequest(selected_text="hello", mode="not_a_mode")


def test_accepts_valid_request():
    r = ChatRequest(selected_text="What is gravity?", mode="simple_explain")
    assert r.mode == "simple_explain"


def test_estimate_tokens_counts_words():
    assert estimate_tokens("one two three") >= 3
    assert estimate_tokens("") == 0
