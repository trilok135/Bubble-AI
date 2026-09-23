"""Personalization profile endpoints, keyed by the authenticated Bubble AI user."""
import json

from fastapi import APIRouter, Depends

from backend.auth.dependencies import get_current_user
from backend.db import get_conn

router = APIRouter(prefix="/profile", tags=["profile"])


@router.get("")
async def get_profile(user: dict = Depends(get_current_user)):
    """The user's personalization profile (difficulty, struggle score, topics)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM user_profile WHERE user_id = ?", (str(user["id"]),)
        ).fetchone()
    if not row:
        return {"profile": {"difficulty_preference": "medium", "struggle_score": 0.0, "topics_confidence": {}}}
    d = dict(row)
    for field in ("topics_confidence", "mastery_level"):
        if isinstance(d.get(field), str):
            try:
                d[field] = json.loads(d[field])
            except Exception:
                d[field] = {}
    return {"profile": d}


@router.delete("")
async def delete_profile(user: dict = Depends(get_current_user)):
    """Deletes the authenticated user's personalization profile."""
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM user_profile WHERE user_id = ?", (str(user["id"]),))
    return {"deleted": True, "message": "Profile deleted successfully"}
