from typing import Dict, Any

class UserProfileEngine:
    def __init__(self):
        pass

    def calculate_struggle_score(self, quiz_accuracy: float, time_spent: float) -> float:
        """
        Calculates a struggle score based on quiz accuracy.
        (1.0 - accuracy) is a basic metric, but time can scale it.
        """
        base_struggle = 1.0 - max(0.0, min(1.0, quiz_accuracy))
        return base_struggle

    def generate_prompt_guidance(self, user_profile: Dict[str, Any], current_topic: str) -> str:
        """
        Adjusts prompt guidance based on user struggle score and preferred difficulty.
        """
        difficulty = user_profile.get("difficulty_preference", "medium")
        struggle_score = user_profile.get("struggle_score", 0.0)
        topic_confidence = user_profile.get("topics_confidence", {}).get(current_topic, 0.5)
        
        guidance_parts = []
        
        # Difficulty guidance
        if difficulty == "low" or struggle_score > 0.7 or topic_confidence < 0.3:
            guidance_parts.append("The user finds this topic challenging. Use simpler terms, analogies, and step-by-step explanations.")
        elif difficulty == "high" and struggle_score < 0.3 and topic_confidence > 0.7:
            guidance_parts.append("The user is highly confident in this topic. Feel free to dive into advanced concepts, edge cases, and nuances.")
        else:
            guidance_parts.append("Keep the explanation balanced and accessible.")
            
        return " ".join(guidance_parts)
