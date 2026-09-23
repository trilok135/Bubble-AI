import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache

class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    DATABASE_URL: str = "sqlite:///./data/bubble.db"
    ENCRYPTION_KEY: str = os.getenv("ENCRYPTION_KEY", "")
    
    # API Keys (loaded from env)
    GROQ_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    
    # Application Configuration
    MEMORY_COMPRESSION_INTERVAL: int = 5
    MAX_CONTEXT_MESSAGES: int = 20
    RATE_LIMIT: int = 100
    
    model_config = SettingsConfigDict(
        env_file=".env", 
        env_file_encoding="utf-8", 
        extra="ignore"
    )

@lru_cache()
def get_settings() -> Settings:
    return Settings()

settings = get_settings()
