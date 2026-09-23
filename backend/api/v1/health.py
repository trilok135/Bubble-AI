from fastapi import APIRouter
from backend.db import list_provider_config

router = APIRouter(prefix="/health", tags=["health"])

@router.get("")
async def health():
    """
    General health check endpoint.
    """
    return {"status": "ok"}

@router.get("/providers")
async def providers_health():
    """
    Checks the status of configured providers.
    """
    providers = list_provider_config()
    return {"providers": [{"name": p["name"], "enabled": bool(p["enabled"])} for p in providers]}
