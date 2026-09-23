import httpx

from .base import (
    AIProvider,
    AuthError,
    InvalidRequestError,
    OutageError,
    RateLimitError,
    ServerError,
)

OPENAI_BASE = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"


class OpenAIProvider(AIProvider):
    name = "openai"

    def __init__(self, api_key: str, model: str | None = None, timeout: float = 60.0, **kwargs):
        super().__init__(api_key)
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.4,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                r = await client.post(
                    f"{OPENAI_BASE}/chat/completions", headers=self._headers(), json=body
                )
            except httpx.HTTPError as exc:
                raise OutageError(f"openai unreachable: {exc}") from exc
        return self._parse(r)

    async def generate(self, prompt: str, context: dict) -> str:
        system = context.get("system_prompt") or "You are a helpful AI study assistant."
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        return await self.generate_messages(messages)

    def _parse(self, r: httpx.Response) -> str:
        status = r.status_code
        if status == 200:
            try:
                return r.json()["choices"][0]["message"]["content"].strip()
            except (KeyError, IndexError) as exc:
                raise OutageError("openai returned empty content") from exc
        if status in (401, 403):
            raise AuthError(f"openai auth failed ({status})")
        if status == 429:
            raise RateLimitError("openai rate limited (429)")
        if status == 400:
            raise InvalidRequestError(f"openai invalid request ({status})")
        if status >= 500:
            raise ServerError(f"openai server error ({status})")
        raise OutageError(f"openai unexpected status {status}")

    async def health_check(self) -> bool:
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                r = await client.get(f"{OPENAI_BASE}/models", headers=self._headers())
                return r.status_code == 200
            except httpx.HTTPError:
                return False
