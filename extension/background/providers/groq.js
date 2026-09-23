const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b"; // llama-3.3-70b-versatile retired by Groq (404 model_not_found, verified Sep 2026)

export async function callGroq(apiKey, messages, requestJson = false, maxRetries = 2) {
  const payload = {
    model: GROQ_DEFAULT_MODEL,
    messages: messages,
    temperature: 0.7
  };

  if (requestJson) {
    payload.response_format = { type: "json_object" };
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(GROQ_BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";
        return { text };
      }

      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        // Auth error, bad request, or model not found — do NOT retry, fail fast
        const body = await response.text();
        const err = new Error(`Groq Error ${response.status}: ${body}`);
        err.fatal = true; // non-retryable: must not be swallowed by the catch below
        throw err;
      }

      console.warn(`Groq API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
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
  
  throw new Error("Max retries exceeded for Groq.");
}

export async function checkGroqHealth(apiKey) {
  try {
    const res = await callGroq(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}
