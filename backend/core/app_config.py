"""Centralized application configuration for Bubble AI backend.

All settings load from environment variables (.env supported via pydantic-settings).
Secrets (AI keys, signing keys) are read here and never injected into client code.
"""
import os
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # "development" keeps permissive defaults (permissive CORS, auto-created tables);
    # anything else (e.g. "production") enables restrictive CORS and stricter checks.
    ENVIRONMENT: str = "development"

    # Comma-separated allowlist. Empty in development -> permissive CORS for local
    # work; in production an empty allowlist locks CORS down to nothing.
    CORS_ORIGINS: str = ""

    # Google OAuth (public client ID — not a secret — but still centralized).
    GOOGLE_CLIENT_ID: str = ""

    # Session lifetime for Bubble AI application sessions (seconds). Default 7 days.
    SESSION_TTL_SECONDS: int = 7 * 24 * 3600

    # AI provider keys (server-side only; never sent to clients)
    GROQ_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    OPENAI_API_KEY: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        """Parsed CORS allowlist. Trailing slashes stripped for consistent matching."""
        raw = (self.CORS_ORIGINS or "").strip()
        if not raw:
            return []
        return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
