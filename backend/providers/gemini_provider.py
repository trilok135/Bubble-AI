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

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-flash-latest"
MAX_TOKENS = 1024
MAX_RETRIES = 3
INITIAL_BACKOFF = 0.5


class GeminiProvider(AIProvider):
    name = "gemini"

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

    async def generate_messages(self, messages: list[dict[str, str]]) -> str:
        contents = []
        for msg in messages:
            # map 'system' to 'user' for Gemini if systemInstruction is not used,
            # or just collapse system into the first user message.
            role = msg["role"]
            if role == "system":
                role = "user"
            
            # Gemini roles are 'user' and 'model'
            if role == "assistant":
                role = "model"
                
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})
            
        body = {
            "contents": contents,
            "generationConfig": {
                "temperature": 0.4,
                "maxOutputTokens": self.max_tokens,
            },
        }
        url = f"{GEMINI_BASE}/models/{self.model}:generateContent"
        headers = {"x-goog-api-key": self.api_key}

        backoff = INITIAL_BACKOFF
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                try:
                    r = await client.post(url, headers=headers, json=body)
                except httpx.TimeoutException as exc:
                    last_error = OutageError(f"gemini request timed out (attempt {attempt}/{MAX_RETRIES})")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                        continue
                    raise last_error from exc
                except httpx.HTTPError as exc:
                    last_error = OutageError(f"gemini network error: {exc}")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                        continue
                    raise last_error from exc

            status = r.status_code
            if status == 200:
                try:
                    return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
                except (KeyError, IndexError) as exc:
                    raise OutageError("gemini returned empty content structure") from exc

            try:
                reason = r.json().get("error", {}).get("status", "") or ""
            except Exception:
                reason = ""

            if status in (401, 403) or (
                status == 400 and reason in ("PERMISSION_DENIED", "UNAUTHENTICATED", "API_KEY_INVALID")
            ):
                raise AuthError(f"gemini auth failed ({status} {reason})")
            if status == 400:
                raise InvalidRequestError(f"gemini blocked/invalid ({status} {reason})")

            if status == 429:
                last_error = RateLimitError(f"gemini rate limited / quota failure (429, attempt {attempt}/{MAX_RETRIES})")
            elif status >= 500:
                last_error = ServerError(f"gemini server error ({status}, attempt {attempt}/{MAX_RETRIES})")
            else:
                last_error = OutageError(f"gemini unexpected status code ({status})")

            if attempt < MAX_RETRIES:
                logger.warning(f"Gemini API returned status {status}, retrying in {backoff}s (attempt {attempt}/{MAX_RETRIES})")
                await asyncio.sleep(backoff)
                backoff *= 2.0
            else:
                raise last_error

        raise last_error or OutageError("gemini failed after maximum retries")

    async def generate(self, prompt: str, context: dict) -> str:
        system = context.get("system_prompt") or "You are a helpful AI study assistant."
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ]
        return await self.generate_messages(messages)



    async def health_check(self) -> bool:
        url = f"{GEMINI_BASE}/models"
        headers = {"x-goog-api-key": self.api_key}
        async with httpx.AsyncClient(timeout=5.0) as client:
            try:
                r = await client.get(url, headers=headers)
                return r.status_code == 200
            except httpx.HTTPError:
                return False

