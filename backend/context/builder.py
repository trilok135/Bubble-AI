import json
from typing import List, Dict, Any, Optional

class ContextBuilder:
    def __init__(self, max_tokens: int = 4000):
        self.max_tokens = max_tokens

    def build_system_prompt(
        self,
        mode_objective: str,
        user_profile_context: str,
        structured_memory: Optional[Dict[str, Any]],
        page_context: Optional[str]
    ) -> str:
        prompt_parts = []
        
        # 1. Base Role & Objective
        prompt_parts.append(f"You are Bubble AI, a persistent and adaptive learning companion. Your current objective: {mode_objective}")
        
        # 2. Personalization
        if user_profile_context:
            prompt_parts.append(f"\nUser Profile:\n{user_profile_context}")
            
        # 3. Memory
        if structured_memory and isinstance(structured_memory, dict):
            memory_str = json.dumps(structured_memory, indent=2)
            prompt_parts.append(f"\nPast Context & Structured Memory:\n{memory_str}")
            
        # 4. Page Context (Browser)
        if page_context:
            prompt_parts.append(f"\nRelevant Page Context (Read-Only context from the user's browser):\n{page_context}")
            
        return "\n".join(prompt_parts)

    def assemble_messages(
        self, 
        system_prompt: str, 
        recent_messages: List[Dict[str, str]], 
        new_user_message: str
    ) -> List[Dict[str, str]]:
        messages = [{"role": "system", "content": system_prompt}]
        
        # Append recent history
        for msg in recent_messages:
            messages.append({"role": msg["role"], "content": msg["content"]})
            
        # Append the current request
        messages.append({"role": "user", "content": new_user_message})
        
        return messages
