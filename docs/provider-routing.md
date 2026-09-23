# Provider Routing

The Client-Side AI Router (`background/router.js`) supports dynamic order resolution and fallback directly from the browser.

- **Deep Reasoning Tasks (exam, deep dive)**: Prioritizes Gemini and OpenAI.
- **Light Tasks (make_notes, 2mark)**: Prioritizes Groq.
- **Medium Tasks (explain, etc.)**: Prioritizes Groq, then Gemini, then OpenAI.

If a provider API returns a 429 or 5xx error, the client automatically applies exponential backoff and retries. If all retries fail, it falls back to the next provider in the chain.

Auth errors (400, 401, 403) fail immediately without retrying on the same provider, immediately triggering a fallback to the next provider.
