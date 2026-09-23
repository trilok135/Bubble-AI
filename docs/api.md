# Internal API Documentation

Bubble AI no longer uses a REST API. All communication happens via Chrome Extension Message Passing (`chrome.runtime.sendMessage`).

## `new-session`
Create a new chat session.
**Payload:**
```javascript
chrome.runtime.sendMessage({ type: "new-session", subject: null, topic: null });
```
**Response:** `{ sessionId: 1 }` or `{ error: "..." }`

## `chat`
Send a message and get an AI response.
**Payload:**
```javascript
chrome.runtime.sendMessage({
  type: "chat",
  sessionId: 1,
  mode: "explain",
  selectedText: "..."
});
```
**Response:** `{ text: "...", providerUsed: "gemini", fellBack: false }` or `{ error: "..." }`

## `get-provider-status`
Get health and usage of configured AI providers.
**Payload:**
```javascript
chrome.runtime.sendMessage({ type: "get-provider-status" });
```
**Response:** Array of `{ name, hasKey, healthy, requests_today }`.

## `clear-memory`
Clear memory for a given session.
**Payload:**
```javascript
chrome.runtime.sendMessage({ type: "clear-memory", sessionId: 1 });
```
**Response:** `{ ok: true }`
