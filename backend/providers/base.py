from abc import ABC, abstractmethod


class ProviderError(Exception):
    """Base class for all provider failures."""


class AuthError(ProviderError):
    """Invalid or missing credentials (401/403)."""


class InvalidRequestError(ProviderError):
    """Provider rejected the request as invalid (e.g. blocked prompt, 400)."""


class RateLimitError(ProviderError):
    """Provider rate limited (429)."""


class ServerError(ProviderError):
    """Provider returned a 5xx."""


class OutageError(ProviderError):
    """Provider unreachable / connection failure / unexpected status."""


class AIProvider(ABC):
    name: str = "base"

    def __init__(self, api_key: str, **kwargs):
        self.api_key = api_key

    @abstractmethod
    async def generate_messages(self, messages: list[dict[str, str]]) -> str: ...

    @abstractmethod
    async def health_check(self) -> bool: ...
