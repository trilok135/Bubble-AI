from pathlib import Path

from ..schemas import MODES

_PROMPTS_DIR = Path(__file__).resolve().parent
_templates: dict[str, str] = {}


def load_templates() -> None:
    for mode in MODES:
        path = _PROMPTS_DIR / f"{mode}.txt"
        if path.exists():
            _templates[mode] = path.read_text(encoding="utf-8")


def build_prompt(mode: str, selected_text: str, memory_json: str) -> tuple[str, str]:
    """Return (user_message, system_prompt) for the given mode template."""
    if not _templates:
        load_templates()
    template = _templates.get(mode)
    if template is None:
        raise ValueError(f"no prompt template for mode {mode!r}")
    system, _, user = template.partition("<<<USER>>>")
    system = system.replace("{study_memory_json}", memory_json or "{}")
    user = user.replace("{selected_text}", selected_text)
    return user.strip(), system.strip()
