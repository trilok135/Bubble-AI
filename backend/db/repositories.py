from typing import List, Optional
from datetime import datetime, timezone
import json

from backend.db.models import Session, Conversation, Message, UserProfile
from backend.db import get_conn

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

class SessionRepository:
    @staticmethod
    def get(session_id: int) -> Optional[Session]:
        with get_conn() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row:
                return Session(**dict(row))
            return None

    @staticmethod
    def create(subject: str = None, topic: str = None, user_id: int = None) -> Session:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO sessions (subject, topic, user_id, created_at) VALUES (?, ?, ?, ?)",
                (subject, topic, user_id, _now()),
            )
            return Session(id=cur.lastrowid, subject=subject, topic=topic, created_at=datetime.now(timezone.utc))

class ConversationRepository:
    @staticmethod
    def save_message(session_id: int, role: str, content: str, tokens: int = 0) -> None:
        # In a real app we'd save to a messages table. For now we use the existing db schema
        # but abstract it. Assuming we'll add a messages table or store it differently.
        with get_conn() as conn:
            # We'll need to create a messages table in __init__.py if we want this, 
            # or just rely on study_memory for now. Let's create a messages table.
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, tokens) VALUES (?, ?, ?, ?, ?)",
                (session_id, role, content, _now(), tokens)
            )

    @staticmethod
    def get_recent_messages(session_id: int, limit: int = 10) -> List[Message]:
        with get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (session_id, limit)
            ).fetchall()
            return [Message(**dict(row)) for row in reversed(rows)]
