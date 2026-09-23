# Context Management

Bubble AI handles context through four layers:
1. **Recent Messages Window**: The last N messages in the session.
2. **Structured Memory**: Compressed JSON of long-term concepts, struggle areas, and topics (updated every 5 exchanges).
3. **User Profile**: Persistent difficulty preferences and topic confidences.
4. **Browser Context**: The selected text and page context provided by the MV3 Extension.

This avoids exceeding token limits while maintaining high relevancy.
