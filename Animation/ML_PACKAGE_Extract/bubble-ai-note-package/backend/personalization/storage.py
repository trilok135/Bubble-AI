"""
SQLite persistence for the personalization layer.

Interaction *text* is stored Fernet-encrypted at rest (matches the
project's existing key-protection approach) — embeddings are stored
unencrypted since a vector alone doesn't reconstruct the original text,
and you need to query/cluster on them without decrypting every row.
"""

from __future__ import annotations
import sqlite3
import json
from pathlib import Path
import numpy as np
from cryptography.fernet import Fernet


SCHEMA = """
CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    encrypted_text BLOB NOT NULL,
    embedding TEXT NOT NULL,   -- JSON-encoded float list
    topic_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY,
    centroid TEXT NOT NULL,           -- JSON-encoded float list
    interaction_count INTEGER NOT NULL,
    struggle_score REAL DEFAULT 0.0
);
"""


class PersonalizationStore:
    def __init__(self, db_path: str = "bubble_personalization.db", key: bytes | None = None):
        self._conn = sqlite3.connect(db_path)
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        self._fernet = Fernet(key or Fernet.generate_key())

    def save_interaction(self, text: str, embedding: np.ndarray, topic_id: int, mode: str) -> None:
        encrypted = self._fernet.encrypt(text.encode("utf-8"))
        self._conn.execute(
            "INSERT INTO interactions (encrypted_text, embedding, topic_id, mode) VALUES (?, ?, ?, ?)",
            (encrypted, json.dumps(embedding.tolist()), topic_id, mode),
        )
        self._conn.commit()

    def upsert_topic(self, topic_id: int, centroid: np.ndarray, interaction_count: int, struggle_score: float) -> None:
        self._conn.execute(
            """INSERT INTO topics (id, centroid, interaction_count, struggle_score)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 centroid=excluded.centroid,
                 interaction_count=excluded.interaction_count,
                 struggle_score=excluded.struggle_score""",
            (topic_id, json.dumps(centroid.tolist()), interaction_count, struggle_score),
        )
        self._conn.commit()

    def load_interactions_for_topic(self, topic_id: int) -> list[tuple[str, np.ndarray]]:
        rows = self._conn.execute(
            "SELECT encrypted_text, embedding FROM interactions WHERE topic_id = ?", (topic_id,)
        ).fetchall()
        out = []
        for encrypted_text, embedding_json in rows:
            text = self._fernet.decrypt(encrypted_text).decode("utf-8")
            out.append((text, np.array(json.loads(embedding_json))))
        return out

    def close(self) -> None:
        self._conn.close()
