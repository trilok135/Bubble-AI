import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from backend.memory import StudyMemory

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "bubble.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  subject TEXT,
  topic TEXT,
  created_at TEXT,
  exchange_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS study_memory (
  session_id INTEGER UNIQUE,
  json_blob TEXT,
  updated_at TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS provider_config (
  name TEXT PRIMARY KEY,
  api_key_encrypted TEXT,
  enabled INTEGER,
  priority INTEGER
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY,
  provider TEXT,
  ts TEXT,
  success INTEGER,
  tokens_est INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER,
  role TEXT,
  content TEXT,
  timestamp TEXT,
  tokens INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS user_profile (
  user_id TEXT PRIMARY KEY,
  difficulty_preference TEXT DEFAULT 'medium',
  struggle_score REAL DEFAULT 0.0,
  mastery_level TEXT,
  topics_confidence TEXT
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  name TEXT,
  parent_topic TEXT,
  confidence_score REAL
);
"""


def get_conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        # users/auth_identities/app_sessions must exist first: the sessions
        # table's user_id REFERENCES users(id).
        from backend.auth.store import ensure_auth_schema
        ensure_auth_schema(conn)
        conn.executescript(SCHEMA)
        _migrate_existing(conn)


def _migrate_existing(conn) -> None:
    """Add columns to tables created by older dev databases. Idempotent."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "user_id" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- sessions ----------
def create_session(subject=None, topic=None, user_id: int | None = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (subject, topic, user_id, created_at) VALUES (?, ?, ?, ?)",
            (subject, topic, user_id, _now()),
        )
        return cur.lastrowid


def get_session(session_id: int):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()


def increment_exchange(session_id: int) -> int:
    with get_conn() as conn:
        conn.execute(
            "UPDATE sessions SET exchange_count = exchange_count + 1 WHERE id = ?",
            (session_id,),
        )
        row = conn.execute(
            "SELECT exchange_count FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return row["exchange_count"] if row else 0


# ---------- study memory ----------
def load_memory(session_id: int) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT json_blob FROM study_memory WHERE session_id = ?", (session_id,)
        ).fetchone()
        return row["json_blob"] if row else None


def save_memory(session_id: int, memory: StudyMemory) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO study_memory (session_id, json_blob, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET "
            "json_blob = excluded.json_blob, updated_at = excluded.updated_at",
            (session_id, memory.model_dump_json(), _now()),
        )


# ---------- provider config ----------
def upsert_provider(name: str, api_key_encrypted: str | None, enabled: int, priority: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO provider_config (name, api_key_encrypted, enabled, priority) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET "
            "api_key_encrypted = COALESCE(excluded.api_key_encrypted, api_key_encrypted), "
            "enabled = excluded.enabled, "
            "priority = excluded.priority",
            (name, api_key_encrypted, int(enabled), int(priority)),
        )


def list_provider_config():
    with get_conn() as conn:
        return conn.execute(
            "SELECT name, api_key_encrypted, enabled, priority FROM provider_config "
            "ORDER BY priority ASC, name ASC"
        ).fetchall()


def enabled_providers():
    with get_conn() as conn:
        return conn.execute(
            "SELECT name, api_key_encrypted, priority FROM provider_config "
            "WHERE enabled = 1 AND api_key_encrypted IS NOT NULL AND api_key_encrypted != '' "
            "ORDER BY priority ASC"
        ).fetchall()


# ---------- usage ----------
def log_usage(provider: str, success: bool, tokens_est: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO usage_log (provider, ts, success, tokens_est) VALUES (?, ?, ?, ?)",
            (provider, _now(), int(success), int(tokens_est)),
        )


def requests_today(provider: str) -> int:
    today = _now()[:10]
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM usage_log WHERE provider = ? AND ts LIKE ?",
            (provider, today + "%"),
        ).fetchone()
        return row["n"] if row else 0
