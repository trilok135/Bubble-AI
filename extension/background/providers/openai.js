const OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

export async function callOpenAI(apiKey, messages, requestJson = false, maxRetries = 2) {
  const payload = {
    model: OPENAI_DEFAULT_MODEL,
    messages: messages,
    temperature: 0.7
  };

  if (requestJson) {
    payload.response_format = { type: "json_object" };
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(OPENAI_BASE_URL, {
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

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new Error(`OpenAI Error ${response.status}: ${await response.text()}`);
      }

      console.warn(`OpenAI API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
    } catch (e) {
      if (attempt >= maxRetries) {
        throw e;
      }
    }
    
    attempt++;
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  
  throw new Error("Max retries exceeded for OpenAI.");
}

export async function checkOpenAIHealth(apiKey) {
  try {
    const res = await callOpenAI(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}
