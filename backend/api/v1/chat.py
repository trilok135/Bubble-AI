from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any

from backend.auth.dependencies import get_current_user
from backend.db import get_session as db_get_session, create_session as db_create_session
from backend.db.repositories import SessionRepository, ConversationRepository
from backend.context.builder import ContextBuilder
from backend.modes.config import get_mode_config
from backend.personalization.user_profile import UserProfileEngine

router = APIRouter(prefix="/chat", tags=["chat"])

class ChatRequest(BaseModel):
    session_id: Optional[int] = None
    message: str
    selected_text: Optional[str] = None
    page_context: Optional[str] = None
    mode: str = "Explain"
    url: Optional[str] = None

class ChatResponse(BaseModel):
    session_id: int
    text: str
    provider_used: str

@router.post("", response_model=ChatResponse)
async def chat(request: ChatRequest, user: dict = Depends(get_current_user)):
    """
    Handles a chat interaction from the Bubble AI extension.
    Requires a Bubble AI session (Authorization: Bearer <session_token>).
    """
    # 0. Ownership: a client-supplied session_id must belong to the caller.
    if request.session_id:
        owned = db_get_session(request.session_id)
        if not owned or owned["user_id"] != user["id"]:
            # 404 (not 403) so we don't reveal other users' session ids exist.
            raise HTTPException(status_code=404, detail="Session not found")

    # 1. Resolve Session
    if request.session_id:
        session = SessionRepository.get(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        session_id = session.id
    else:
        session = SessionRepository.create(subject="General", topic="Web Browsing", user_id=user["id"])
        session_id = session.id

    # 2. Extract Context
    mode_config = get_mode_config(request.mode)
    recent_msgs = ConversationRepository.get_recent_messages(session_id)
    
    # User Profile (Mock for now)
    profile_engine = UserProfileEngine()
    user_profile = {"difficulty_preference": "medium", "struggle_score": 0.2}
    guidance = profile_engine.generate_prompt_guidance(user_profile, "General")
    
    # 3. Build Context
    builder = ContextBuilder()
    sys_prompt = builder.build_system_prompt(
        mode_objective=mode_config.objective,
        user_profile_context=guidance,
        structured_memory={"last_topic": "Unknown"},
        page_context=request.page_context
    )
    
    messages = builder.assemble_messages(
        system_prompt=sys_prompt,
        recent_messages=[{"role": m.role, "content": m.content} for m in recent_msgs],
        new_user_message=f"Selected Text: {request.selected_text}\nQuestion: {request.message}" if request.selected_text else request.message
    )

    # 4. Route to AI
    from backend.main import build_providers, get_routing_order
    from backend.router import AIRouter
    
    providers = build_providers()
    if not providers:
        raise HTTPException(status_code=400, detail="no providers configured")

    routing_order = get_routing_order(request.mode, providers)
    ai_router = AIRouter(providers, routing_order)
    
    try:
        response = await ai_router.route(messages=messages, mode=request.mode)
        
        # Save messages
        ConversationRepository.save_message(session_id, "user", request.message)
        ConversationRepository.save_message(session_id, "assistant", response.text)
        
        return ChatResponse(
            session_id=session_id,
            text=response.text,
            provider_used=response.provider_used
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
