const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-flash-latest"; // gemini-2.5-flash closed to new API keys (404); alias matches backend and auto-tracks newest flash

function toGeminiFormat(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = {
        parts: [{ text: msg.content }]
      };
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }

  return { contents, systemInstruction };
}

export async function callGemini(apiKey, messages, requestJson = false, maxRetries = 2) {
  const { contents, systemInstruction } = toGeminiFormat(messages);
  
  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.7
    }
  };
  
  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }
  
  if (requestJson) {
    payload.generationConfig.responseMimeType = "application/json";
  }

  const url = `${BASE_URL}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return { text };
      }

      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        // Auth error, bad request, or model not found — do NOT retry, fail fast
        const body = await response.text();
        const err = new Error(`Gemini Error ${response.status}: ${body}`);
        err.fatal = true; // non-retryable: must not be swallowed by the catch below
        throw err;
      }

      // 429 or 5xx, retry with exponential backoff
      console.warn(`Gemini API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
    } catch (e) {
      if (attempt >= maxRetries || e.fatal) {
        throw e;
      }
    }
    
    attempt++;
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  
  throw new Error("Max retries exceeded for Gemini.");
}

export async function checkGeminiHealth(apiKey) {
  try {
    const res = await callGemini(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}
