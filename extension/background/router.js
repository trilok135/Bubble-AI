import { callGemini } from "./providers/gemini.js";
import { callGroq } from "./providers/groq.js";
import { callOpenAI } from "./providers/openai.js";

const REASONING_DEPTH = {
  explain: "medium", 
  simple_explain: "medium", 
  example: "medium",
  code_explain: "medium", 
  "2mark": "light", 
  longform: "medium",
  quiz_me: "medium", 
  make_notes: "light",
  exam: "deep",
  deep_dive: "deep",
  practice: "medium"
};

export async function route(messages, mode, availableProviders, requestJson = false) {
  if (!availableProviders || availableProviders.length === 0) {
    throw new Error("No AI providers configured or enabled. Please add an API key in Settings.");
  }

  const order = buildProviderOrder(mode, availableProviders);
  let fellBack = false;
  const failureLog = [];

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    if (i > 0) fellBack = true;

    try {
      console.log(`[Bubble Router] Attempting provider ${i + 1}/${order.length}: ${provider.name}`);
      let result;
      if (provider.name === "gemini") {
        result = await callGemini(provider.apiKey, messages, requestJson);
      } else if (provider.name === "groq") {
        result = await callGroq(provider.apiKey, messages, requestJson);
      } else if (provider.name === "openai") {
        result = await callOpenAI(provider.apiKey, messages, requestJson);
      } else {
        throw new Error(`Unknown provider: ${provider.name}`);
      }
      
      return { 
        text: result.text, 
        providerUsed: provider.name, 
        fellBack 
      };
    } catch (e) {
      const pErr = `${provider.name}: ${e.message || "Request failed"}`;
      console.warn(`[Bubble Router] Provider ${provider.name} failed:`, e.message);
      failureLog.push(pErr);
      
      if (i === order.length - 1) {
        throw new Error(`All providers failed. Attempted chain -> [${failureLog.join(" | ")}]`);
      }
    }
  }
}

function buildProviderOrder(mode, providers) {
  const depth = REASONING_DEPTH[mode] || "medium";
  const sorted = [...providers].sort((a, b) => a.priority - b.priority);

  const groq = sorted.find(p => p.name === "groq");
  const gemini = sorted.find(p => p.name === "gemini");
  const openai = sorted.find(p => p.name === "openai");

  const ordered = [];

  if (depth === "deep") {
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
    if (groq) ordered.push(groq);
  } else if (depth === "light") {
    if (groq) ordered.push(groq);
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
  } else {
    if (groq) ordered.push(groq);
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
  }

  for (const p of sorted) {
    if (!ordered.find(o => o.name === p.name)) {
      ordered.push(p);
    }
  }

  return ordered;
}
