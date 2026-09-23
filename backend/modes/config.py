from enum import Enum
from pydantic import BaseModel

class ReasoningDepth(str, Enum):
    LIGHT = "light"
    MEDIUM = "medium"
    DEEP = "deep"

class ModeConfig(BaseModel):
    name: str
    objective: str
    reasoning_depth: ReasoningDepth
    tone: str
    memory_influence: bool = True
    follow_up_encouragement: bool = True

# Canonical Mode Definitions
MODE_CONFIG = {
    "explain": ModeConfig(
        name="Explain",
        objective="Explain the provided text or concept clearly.",
        reasoning_depth=ReasoningDepth.MEDIUM,
        tone="educational and encouraging",
    ),
    "simple_explain": ModeConfig(
        name="Simple Explain",
        objective="Explain the topic simply with everyday analogies for a beginner.",
        reasoning_depth=ReasoningDepth.LIGHT,
        tone="simple, warm, and accessible",
    ),
    "example": ModeConfig(
        name="Example",
        objective="Provide worked step-by-step examples illustrating the concept.",
        reasoning_depth=ReasoningDepth.MEDIUM,
        tone="practical and illustrative",
    ),
    "code_explain": ModeConfig(
        name="Code Explain",
        objective="Explain code line-by-line or provide annotated code implementations.",
        reasoning_depth=ReasoningDepth.DEEP,
        tone="technical and precise",
    ),
    "2mark": ModeConfig(
        name="2-mark Answer",
        objective="Write a concise 2-point exam answer in markscheme style.",
        reasoning_depth=ReasoningDepth.LIGHT,
        tone="academic and concise",
    ),
    "longform": ModeConfig(
        name="Longform",
        objective="Provide a comprehensive deep-dive study explainer with subheadings.",
        reasoning_depth=ReasoningDepth.DEEP,
        tone="detailed and exhaustive",
    ),
    "quiz_me": ModeConfig(
        name="Quiz Me",
        objective="Generate 3 progressive quiz questions with model answers.",
        reasoning_depth=ReasoningDepth.MEDIUM,
        tone="challenging and supportive",
    ),
    "make_notes": ModeConfig(
        name="Make Notes",
        objective="Extract structured study notes with definitions and key takeaways.",
        reasoning_depth=ReasoningDepth.LIGHT,
        tone="structured and concise",
    ),
}

# Alias mapping for title casing fallback
for key, val in list(MODE_CONFIG.items()):
    MODE_CONFIG[val.name] = val
    MODE_CONFIG[key.lower()] = val

def get_mode_config(mode_name: str) -> ModeConfig:
    if not mode_name:
        return MODE_CONFIG["explain"]
    return MODE_CONFIG.get(mode_name.lower(), MODE_CONFIG.get(mode_name, MODE_CONFIG["explain"]))
