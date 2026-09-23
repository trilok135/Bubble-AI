import asyncio
import logging
import httpx

from .base import (
    AIProvider,
    AuthError,
    InvalidRequestError,
    OutageError,
    RateLimitError,
    ServerError,
)

logger = logging.getLogger(__name__)

GROQ_BASE = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "openai/gpt-oss-120b"
MAX_TOKENS = 1024
MAX_RETRIES = 3
INITIAL_BACKOFF = 0.5


class GroqProvider(AIProvider):
    name = "groq"

    def __init__(
        self,
        api_key: str,
        model: str | None = None,
        timeout: float = 30.0,
        max_tokens: int = MAX_TOKENS,
        **kwargs,
    ):
        super().__init__(api_key)
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout
        self.max_tokens = max_tokens

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.4,
            "max_tokens": self.max_tokens,
        }

        url = f"{GROQ_BASE}/chat/completions"
        backoff = INITIAL_BACKOFF
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                try:
                    r = await client.post(url, headers=self._headers(), json=body)
                except httpx.TimeoutException as exc:
                    last_error = OutageError(f"groq request timed out (attempt {attempt}/{MAX_RETRIES})")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                        continue
                    raise last_error from exc
                except httpx.HTTPError as exc:
                    last_error = OutageError(f"groq network error: {exc}")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                        continue
                    raise last_error from exc

            status = r.status_code
            if status == 200:
                try:
                    return r.json()["choices"][0]["message"]["content"].strip()
                except (KeyError, IndexError) as exc:
                    raise OutageError("groq returned empty content structure") from exc

            if status in (401, 403):
                raise AuthError(f"groq authentication failed (status {status})")
            if status == 400:
                raise InvalidRequestError(f"groq invalid request (status {status})")

            # Retryable status codes: 429 (quota/rate limit), 500, 502, 503
            if status == 429:
                last_error = RateLimitError(f"groq rate limited / quota failure (429, attempt {attempt}/{MAX_RETRIES})")
            elif status in (500, 502, 503):
                last_error = ServerError(f"groq server error ({status}, attempt {attempt}/{MAX_RETRIES})")
            else:
                last_error = OutageError(f"groq unexpected status code ({status})")

            if attempt < MAX_RETRIES:
                logger.warning(f"Groq API returned status {status}, retrying in {backoff}s (attempt {attempt}/{MAX_RETRIES})")
                await asyncio.sleep(backoff)
                backoff *= 2.0
            else:
                raise last_error

        raise last_error or OutageError("groq failed after maximum retries")

    async def generate(self, prompt: str, context: dict) -> str:
        system = context.get("system_prompt") or "You are a helpful AI study assistant."
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        return await self.generate_messages(messages)


    async def health_check(self) -> bool:
        async with httpx.AsyncClient(timeout=5.0) as client:
            try:
                r = await client.get(f"{GROQ_BASE}/models", headers=self._headers())
                return r.status_code == 200
            except httpx.HTTPError:
                return False
