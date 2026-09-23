"""Conversation endpoints. All data is user-scoped and ownership-checked."""
from fastapi import APIRouter, Depends, HTTPException
from typing import List

from backend.auth.dependencies import get_current_user
from backend.db import get_conn
from backend.db.repositories import ConversationRepository

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _serialize_session(row, include_messages: bool) -> dict:
    out = {
        "id": row["id"],
        "subject": row["subject"],
        "topic": row["topic"],
        "created_at": row["created_at"],
        "exchange_count": row["exchange_count"],
        "message_count": None,
    }
    if include_messages:
        msgs = ConversationRepository.get_recent_messages(row["id"], limit=1000)
        out["messages"] = [
            {"role": m.role, "content": m.content, "timestamp": str(m.timestamp)}
            for m in msgs
        ]
        out["message_count"] = len(out["messages"])
    return out


@router.get("")
async def list_conversations(user: dict = Depends(get_current_user)):
    """List the authenticated user's conversations (newest first)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 200",
            (user["id"],),
        ).fetchall()
    return {"conversations": [_serialize_session(r, include_messages=False) for r in rows]}


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: int, user: dict = Depends(get_current_user)):
    """Get one conversation with messages. Ownership is verified — a session_id
    belonging to another user returns 404, never its contents."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
            (conversation_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize_session(row, include_messages=True)


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: int, user: dict = Depends(get_current_user)):
    """Delete the user's own conversation (messages + memory + session row)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM sessions WHERE id = ? AND user_id = ?",
            (conversation_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Conversation not found")
        conn.execute("DELETE FROM messages WHERE session_id = ?", (conversation_id,))
        conn.execute("DELETE FROM study_memory WHERE session_id = ?", (conversation_id,))
        conn.execute("DELETE FROM sessions WHERE id = ?", (conversation_id,))
    return {"deleted": True, "id": conversation_id}
