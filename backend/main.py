import asyncio
import logging
import os
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .crypto import decrypt_secret, encrypt_secret
from .memory import StudyMemory, compress
from .prompts import build_prompt, load_templates
from .auth.dependencies import get_current_user, get_admin_user
from .providers.base import AIProvider, AuthError, InvalidRequestError, OutageError, ProviderError, RateLimitError, ServerError
from .providers.gemini_provider import GeminiProvider
from .providers.groq_provider import GroqProvider
from .providers.openai_provider import OpenAIProvider
from .providers.openrouter_provider import OpenRouterProvider
from .router import AIRouter
from .schemas import (
    ChatRequest,
    CompressRequest,
    NewSessionRequest,
    ProviderConfigRequest,
    ProviderConfigView,
    ProviderStatus,
    estimate_tokens,
)
from backend.api.v1.auth import router as auth_router
from backend.api.v1.chat import router as chat_router
from backend.api.v1.conversations import router as conversations_router
from backend.api.v1.memory import router as memory_router
from backend.api.v1.profile import router as profile_router
from backend.api.v1.health import router as health_router
from backend.core.errors import setup_exception_handlers

logger = logging.getLogger(__name__)

# Load .env file automatically
def _load_env_file():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

_load_env_file()

PROVIDER_CLASSES = {
    "groq": GroqProvider,
    "gemini": GeminiProvider,
    "openai": OpenAIProvider,
    "openrouter": OpenRouterProvider,
}
COMPRESS_PROVIDER_DEFAULT = "groq"
COMPRESS_EVERY_N = 5
MAX_INPUT_LENGTH = 4000
RATE_LIMIT_WINDOW = 60.0  # seconds
RATE_LIMIT_MAX_REQUESTS = 30

# Simple sliding window rate limiter
_rate_limit_tracker = defaultdict(list)


def _check_rate_limit(client_ip: str):
    now = time.time()
    timestamps = _rate_limit_tracker[client_ip]
    # Remove timestamps older than window
    _rate_limit_tracker[client_ip] = [t for t in timestamps if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_limit_tracker[client_ip]) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Maximum 30 requests per minute allowed.",
        )
    _rate_limit_tracker[client_ip].append(now)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    load_templates()
    yield


app = FastAPI(title="Bubble AI", version="0.1.0", lifespan=lifespan)

# CORS: environment-driven. Development with no CORS_ORIGINS set stays permissive
# for local work; production MUST set CORS_ORIGINS (locked down, never "*").
# Chrome extension origins (chrome-extension://<id>) are first-class allowed values.
from .core.app_config import settings as _settings

_cors_origins = _settings.cors_origins
if not _cors_origins and not _settings.is_production:
    _cors_origins = ["*"]
    logger.warning("CORS_ORIGINS not set and ENVIRONMENT=development — using permissive CORS. Set CORS_ORIGINS before deploying.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)

setup_exception_handlers(app)

app.include_router(auth_router, prefix="/api/v1")
app.include_router(chat_router, prefix="/api/v1")
app.include_router(conversations_router, prefix="/api/v1")
app.include_router(memory_router, prefix="/api/v1")
app.include_router(profile_router, prefix="/api/v1")
app.include_router(health_router, prefix="/api/v1")


def build_providers() -> list[AIProvider]:
    """Construct configured providers (from DB or environment variables) in priority order."""
    factory = getattr(app.state, "provider_factory", None)
    if factory is not None:
        return factory()

    providers_map = {}

    # 1. Load from DB
    for row in db.enabled_providers():
        cls = PROVIDER_CLASSES.get(row["name"])
        if cls is None:
            continue
        try:
            key = decrypt_secret(row["api_key_encrypted"])
            if key:
                providers_map[row["name"]] = cls(api_key=key)
        except Exception:
            logger.warning("Could not decrypt DB key for provider %s", row["name"])

    # 2. Environment variable fallback
    groq_env_key = os.environ.get("GROQ_API_KEY")
    if groq_env_key and "groq" not in providers_map:
        providers_map["groq"] = GroqProvider(api_key=groq_env_key)

    gemini_env_key = os.environ.get("GEMINI_API_KEY")
    if gemini_env_key and "gemini" not in providers_map:
        providers_map["gemini"] = GeminiProvider(api_key=gemini_env_key)

    openai_env_key = os.environ.get("OPENAI_API_KEY")
    if openai_env_key and "openai" not in providers_map:
        providers_map["openai"] = OpenAIProvider(api_key=openai_env_key)

    openrouter_env_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_env_key and "openrouter" not in providers_map:
        providers_map["openrouter"] = OpenRouterProvider(api_key=openrouter_env_key)

    return list(providers_map.values())


def _compress_provider(providers: list[AIProvider]) -> AIProvider | None:
    """Cheapest provider: env override, else groq / gemini."""
    desired = os.environ.get("BUBBLE_COMPRESS_PROVIDER", COMPRESS_PROVIDER_DEFAULT)
    for p in providers:
        if p.name == desired:
            return p
    return providers[0] if providers else None


def get_routing_order(mode: str, providers: list[AIProvider]) -> list[str]:
    """Mode-based initial routing:
    - Quiz / Exam -> Gemini primary, Groq fallback
    - Explain / Notes / Others -> Groq primary, Gemini fallback
    """
    mode_lower = mode.lower()
    available_names = [p.name for p in providers]

    if mode_lower in ("quiz", "exam"):
        preferred = ["gemini", "openrouter", "groq", "openai"]
    else:
        preferred = ["openrouter", "groq", "gemini", "openai"]

    ordered = [name for name in preferred if name in available_names]
    # Add any remaining configured providers
    for p in available_names:
        if p not in ordered:
            ordered.append(p)
    return ordered


@app.get("/")
def root():
    return {"app": "bubble-ai", "status": "ok"}


@app.get("/login", include_in_schema=False)
def login_page():
    """Web login page: Google One Tap + official Google button.
    The page fetches the public client ID from /api/v1/auth/config itself."""
    from fastapi.responses import FileResponse
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "login.html"), media_type="text/html")


@app.post("/session/new", response_model=dict)
def new_session(req: NewSessionRequest, user: dict = Depends(get_current_user)):
    sid = db.create_session(req.subject, req.topic, user_id=user["id"])
    db.save_memory(sid, StudyMemory(subject=req.subject, topic=req.topic))
    return {"session_id": sid}


@app.get("/session/{session_id}/memory", response_model=StudyMemory)
def session_memory(session_id: int, user: dict = Depends(get_current_user)):
    owned = db.get_session(session_id)
    if not owned or owned["user_id"] != user["id"]:
        raise HTTPException(404, "session not found")
    blob = db.load_memory(session_id)
    return StudyMemory.from_json(blob) if blob else StudyMemory()


@app.post("/session/{session_id}/compress", response_model=StudyMemory)
async def compress_now(session_id: int, req: CompressRequest, user: dict = Depends(get_current_user)):
    owned = db.get_session(session_id)
    if not owned or owned["user_id"] != user["id"]:
        raise HTTPException(404, "session not found")
    memory = StudyMemory.from_json(db.load_memory(session_id) or "{}")
    providers = build_providers()
    cprov = _compress_provider(providers)
    if cprov is None:
        raise HTTPException(400, "no providers configured")
    updated = await compress(memory, {"manual": True}, cprov)
    db.save_memory(session_id, updated)
    return updated


@app.post("/chat", response_model=dict)
async def chat(req: ChatRequest, http_request: Request, user: dict = Depends(get_current_user)):
    # 1. Rate limiting check
    client_ip = http_request.client.host if http_request.client else "127.0.0.1"
    _check_rate_limit(client_ip)

    # 2. Maximum input length limit
    if req.selected_text and len(req.selected_text) > MAX_INPUT_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Input text exceeds maximum allowed length of {MAX_INPUT_LENGTH} characters.",
        )

    # Ownership: a client-supplied session_id must belong to the caller.
    if req.session_id is not None:
        owned = db.get_session(req.session_id)
        if not owned or owned["user_id"] != user["id"]:
            raise HTTPException(404, "session not found")
    session_id = req.session_id
    if session_id is None:
        session_id = db.create_session(req.subject, req.topic, user_id=user["id"])
        db.save_memory(session_id, StudyMemory())

    memory = StudyMemory.from_json(db.load_memory(session_id) or "{}")
    memory_json = memory.compact_json()
    prompt, system = build_prompt(req.mode, req.selected_text, memory_json)

    providers = build_providers()
    if not providers:
        raise HTTPException(400, "no providers configured")

    routing_order = get_routing_order(req.mode, providers)
    router = AIRouter(providers, routing_order)

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt}
    ]
    try:
        resp = await router.route(messages, req.mode)
    except AuthError as exc:
        raise HTTPException(401, f"provider authentication failed: {exc}") from exc
    except InvalidRequestError as exc:
        raise HTTPException(400, f"provider rejected request: {exc}") from exc
    except (RateLimitError, ServerError, OutageError, ProviderError) as exc:
        logger.error("All AI providers failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Service temporarily unavailable. Both AI providers failed to respond. Please try again in a moment.",
        ) from exc

    db.log_usage(
        resp.provider_used,
        success=True,
        tokens_est=estimate_tokens(req.selected_text) + estimate_tokens(resp.text),
    )

    count = db.increment_exchange(session_id)
    if count % COMPRESS_EVERY_N == 0:
        cprov = _compress_provider(providers)
        if cprov is not None:
            new_exchange = {
                "mode": req.mode,
                "selected_text": req.selected_text,
                "answer": resp.text,
            }
            try:
                updated = await compress(memory, new_exchange, cprov)
                db.save_memory(session_id, updated)
            except Exception as e:
                logger.warning("Background memory compression failed: %s", e)

    return resp.model_dump()


@app.post("/providers/config")
def set_provider_config(req: ProviderConfigRequest, _admin: dict = Depends(get_admin_user)):
    if req.name not in PROVIDER_CLASSES:
        raise HTTPException(400, f"unknown provider {req.name!r}")
    enc = None
    if req.api_key:
        enc = encrypt_secret(req.api_key)
    db.upsert_provider(req.name, enc, int(req.enabled), req.priority)
    return {"ok": True}


@app.get("/providers/config", response_model=list[ProviderConfigView])
def provider_configs(_admin: dict = Depends(get_admin_user)):
    out = []
    for row in db.list_provider_config():
        out.append(
            ProviderConfigView(
                name=row["name"],
                has_key=bool(row["api_key_encrypted"]),
                enabled=bool(row["enabled"]),
                priority=int(row["priority"]),
            )
        )
    return out


@app.get("/providers/status", response_model=list[ProviderStatus])
async def provider_status(_admin: dict = Depends(get_admin_user)):
    providers = build_providers()
    statuses = []
    for p in providers:
        statuses.append(
            ProviderStatus(
                name=p.name,
                healthy=await p.health_check(),
                requests_today=db.requests_today(p.name),
            )
        )
    return statuses
