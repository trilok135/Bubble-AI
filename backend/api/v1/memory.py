"""Memory and profile deletion endpoints. All operations are user-scoped."""
from fastapi import APIRouter, Depends

from backend.auth.dependencies import get_current_user
from backend.db import get_conn

router = APIRouter(prefix="/memory", tags=["memory"])


@router.delete("")
async def delete_memory(user: dict = Depends(get_current_user)):
    """Deletes all structured memory belonging to the authenticated user
    across every session they own (GDPR compliance)."""
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM study_memory WHERE session_id IN "
            "(SELECT id FROM sessions WHERE user_id = ?)",
            (user["id"],),
        )
    return {"deleted": True, "memory_rows": cur.rowcount, "message": "Memory deleted successfully"}


@router.get("")
async def get_memory(user: dict = Depends(get_current_user)):
    """Returns the user's per-session memory summaries (their own data only)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT m.session_id, m.json_blob, m.updated_at FROM study_memory m "
            "JOIN sessions s ON s.id = m.session_id WHERE s.user_id = ?",
            (user["id"],),
        ).fetchall()
    return {
        "memories": [
            {"session_id": r["session_id"], "memory": r["json_blob"], "updated_at": r["updated_at"]}
            for r in rows
        ]
    }
