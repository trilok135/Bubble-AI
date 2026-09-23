import os
from pathlib import Path

from cryptography.fernet import Fernet

_KEY_ENV = "BUBBLE_FERNET_KEY"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

_fernet = None


def _load_or_create_key() -> bytes:
    env_key = os.environ.get(_KEY_ENV)
    if env_key:
        return env_key.encode()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_file = DATA_DIR / ".fernet_key"
    if key_file.exists():
        return key_file.read_bytes()
    key = Fernet.generate_key()
    key_file.write_bytes(key)
    return key


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt_secret(value: str) -> str:
    return _get_fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str:
    return _get_fernet().decrypt(token.encode()).decode()
