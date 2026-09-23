import asyncio
import logging
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from .providers.base import (
    AIProvider,
    AuthError,
    InvalidRequestError,
    OutageError,
    ProviderError,
    RateLimitError,
    ServerError,
)
from backend.modes.config import get_mode_config, ReasoningDepth

logger = logging.getLogger(__name__)

class RouterResponse(BaseModel):
    text: str
    provider_used: str
    fell_back: bool

class AIRouter:
    def __init__(self, providers: list[AIProvider], order: list[str]):
        self._providers = {p.name: p for p in providers}
        self.order = order

    def _get_preferred_provider_order(self, mode_name: str) -> List[str]:
        """
        Dynamically determine provider order based on reasoning depth required by the mode.
        """
        config = get_mode_config(mode_name)
        
        # Determine base order from configured fallback order, but adjust based on depth.
        # Deep reasoning -> prefer Gemini or OpenAI first
        # Fast/Light reasoning -> prefer Groq first
        ordered = self.order.copy()
        
        if config.reasoning_depth == ReasoningDepth.DEEP:
            # Shift Gemini / OpenAI to the front if available
            preferred = [p for p in ordered if p.lower() in ["gemini", "openai"]]
            others = [p for p in ordered if p.lower() not in ["gemini", "openai"]]
            return preferred + others
        elif config.reasoning_depth == ReasoningDepth.LIGHT:
            # Shift Groq to the front if available
            preferred = [p for p in ordered if "groq" in p.lower()]
            others = [p for p in ordered if "groq" not in p.lower()]
            return preferred + others
            
        return ordered

    async def route(self, messages: List[Dict[str, str]], mode: str = "Explain") -> RouterResponse:
        last_error: Optional[ProviderError] = None
        attempted = 0
        
        # Determine the order of providers to try
        provider_order = self._get_preferred_provider_order(mode)
        
        for idx, name in enumerate(provider_order):
            provider = self._providers.get(name)
            if provider is None:
                continue
                
            attempted += 1
            max_retries = 2
            
            for retry in range(max_retries):
                try:
                    # In this updated design, generate accepts a list of messages
                    text = await provider.generate_messages(messages)
                    return RouterResponse(
                        text=text, 
                        provider_used=provider.name, 
                        fell_back=idx > 0
                    )
                except (AuthError, InvalidRequestError):
                    # These errors indicate a config/request problem that retrying won't fix
                    raise
                except (RateLimitError, ServerError, OutageError) as exc:
                    last_error = exc
                    if retry < max_retries - 1:
                        backoff = 2 ** retry
                        logger.warning(f"{provider.name} failed with {exc}. Retrying in {backoff}s...")
                        await asyncio.sleep(backoff)
                    else:
                        logger.error(f"{provider.name} failed after retries.")
                        break # Move to next provider

        if not attempted:
            raise OutageError("no providers configured")
        raise last_error or OutageError("all providers failed")
