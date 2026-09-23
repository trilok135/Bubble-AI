from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime

class UserProfile(BaseModel):
    user_id: str
    difficulty_preference: str = "medium"
    struggle_score: float = 0.0
    mastery_level: Dict[str, float] = Field(default_factory=dict)
    topics_confidence: Dict[str, float] = Field(default_factory=dict)

class Message(BaseModel):
    id: Optional[int] = None
    role: str
    content: str
    timestamp: Optional[datetime] = None
    tokens: Optional[int] = None

class Conversation(BaseModel):
    id: Optional[int] = None
    session_id: int
    messages: List[Message] = Field(default_factory=list)

class Topic(BaseModel):
    id: Optional[int] = None
    name: str
    parent_topic: Optional[str] = None
    confidence_score: float = 0.5

class Session(BaseModel):
    id: Optional[int] = None
    subject: Optional[str] = None
    topic: Optional[str] = None
    created_at: Optional[datetime] = None
    exchange_count: int = 0
