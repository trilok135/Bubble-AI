import json
from typing import Dict, Any, List
from datetime import datetime

class MemoryCompressor:
    def __init__(self, interval: int = 5):
        """Compress memory every `interval` exchanges."""
        self.interval = interval

    def should_compress(self, current_exchange_count: int) -> bool:
        return current_exchange_count > 0 and current_exchange_count % self.interval == 0

    def extract_new_memory_state(
        self, 
        existing_memory: Dict[str, Any], 
        recent_messages: List[Dict[str, str]],
        ai_provider_completion_func  # A function or method that can call an AI model
    ) -> Dict[str, Any]:
        """
        Takes the existing memory, the recent chat history, and asks an AI model
        to compress and update the structured memory state.
        """
        # This is a stub for the prompt that would be sent to the AI
        prompt = (
            "You are a memory compression module. Update the following JSON memory state "
            "based on the new chat history provided. Do not hallucinate. Maintain keys: "
            "topic, concepts (list), user_understanding (string), misconceptions (list), "
            "open_questions (list), important_context (string), difficulty (string)."
            f"\n\nExisting Memory:\n{json.dumps(existing_memory)}"
            f"\n\nRecent Chat:\n{json.dumps(recent_messages)}"
        )
        
        # In a real implementation, we would call the AI provider here.
        # compressed_json = ai_provider_completion_func(prompt, response_format="json")
        # return json.loads(compressed_json)
        
        # Stub implementation returning a fake updated memory
        updated_memory = existing_memory.copy()
        if not updated_memory:
            updated_memory = {
                "topic": "Unknown",
                "concepts": [],
                "user_understanding": "Needs assessment.",
                "misconceptions": [],
                "open_questions": [],
                "important_context": "",
                "difficulty": "medium"
            }
        updated_memory["_last_compressed"] = datetime.now().isoformat()
        return updated_memory
