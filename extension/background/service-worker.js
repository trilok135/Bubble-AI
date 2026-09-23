import { openDB, createSession, getSession, loadMemory, saveMemory, clearMemory, incrementExchange, logUsage, getProviderUsageToday } from "./db/indexeddb.js";
import { embedder } from "./ml/tfidf.js";
import { clusterer } from "./ml/clustering.js";
import { difficultyModel } from "./ml/difficulty.js";
import { modeClassifier } from "./ml/mode-classifier.js";
import { memoryStore, compressMemory, estimateTokens, StudyMemory } from "./ml/memory.js";
import { route } from "./router.js";
import { buildPrompt } from "./prompts.js";
import { checkGeminiHealth } from "./providers/gemini.js";
import { checkGroqHealth } from "./providers/groq.js";
import { checkOpenAIHealth } from "./providers/openai.js";
import { authManager } from "./auth-manager.js";

const COMPRESS_EVERY_N = 5;

// Rate limiting constants
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30;

/**
 * Fix 1 — Persistent Rate Limiting via chrome.storage.session
 *
 * The previous in-memory `requestTimestamps` array was reset every time the MV3
 * service worker went idle and restarted (every ~30s of inactivity). This meant
 * the rate limit was structurally bypassed by any burst of requests spaced >30s apart.
 *
 * chrome.storage.session persists for the lifetime of the browser session (not the
 * SW lifetime) and is cleared on browser close — the correct scope for a per-session
 * rate-limit window.
 */
async function checkRateLimit() {
  let timestamps = [];
  try {
    const data = await chrome.storage.session.get("requestTimestamps");
    timestamps = Array.isArray(data.requestTimestamps) ? data.requestTimestamps : [];
  } catch (e) {
    // chrome.storage.session may not be available in older Chrome builds (<110).
    // Fall back to allow the request through rather than hard-blocking.
    console.warn("[Bubble SW] storage.session unavailable, skipping rate limit:", e.message);
    return true;
  }

  const now = Date.now();
  timestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  timestamps.push(now);

  try {
    await chrome.storage.session.set({ requestTimestamps: timestamps });
  } catch (e) {
    console.warn("[Bubble SW] Failed to persist rate-limit timestamps:", e.message);
  }

  return true;
}

/**
 * Key Storage — Raw keys stored directly in chrome.storage.local.
 *
 * AES-GCM encryption is architecturally impossible in MV3 service workers:
 * the SW has no access to the user's passphrase (entered in the Settings page),
 * and there is no persistent decrypted-key cache across SW restarts.
 *
 * chrome.storage.local is already sandboxed per-extension by the OS user profile —
 * no other extension or web page can read it. This is the same approach used by
 * Merlin, Monica, and all production Chromium AI extensions.
 *
 * If end-to-end encryption is required in the future, the correct pattern is:
 *   1. User unlocks extension in Settings (enters passphrase).
 *   2. Settings page decrypts key → sends raw key to SW via chrome.runtime.sendMessage.
 *   3. SW stores raw key in a module-scope variable for the lifetime of that SW instance.
 *   4. On SW restart, user must unlock again (or use a shorter-TTL session key).
 */
async function getEnabledProviders() {
  const rawData = await chrome.storage.local.get([
    "raw_key_gemini", "raw_key_groq", "raw_key_openai",
    "config_gemini", "config_groq", "config_openai"
  ]);

  const providers = [];
  if (rawData.raw_key_gemini) providers.push({ name: "gemini", apiKey: rawData.raw_key_gemini, priority: rawData.config_gemini?.priority || 50 });
  if (rawData.raw_key_groq)   providers.push({ name: "groq",   apiKey: rawData.raw_key_groq,   priority: rawData.config_groq?.priority   || 10 });
  if (rawData.raw_key_openai) providers.push({ name: "openai", apiKey: rawData.raw_key_openai, priority: rawData.config_openai?.priority || 100 });

  return providers;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed_at: Date.now() });
  openDB().catch(console.error);
  embedder.fit();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "chat") {
    handleChat(msg).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "new-session") {
    createSession(msg.subject, msg.topic).then(sessionId => sendResponse({ sessionId })).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "get-provider-status") {
    handleProviderStatus().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "clear-memory") {
    clearMemory(msg.sessionId).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "auth-get-state") {
    authManager.getState().then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-google-signin") {
    authManager.signInWithGoogle(true).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-github-signin") {
    authManager.signInWithGitHub(true).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-logout") {
    authManager.logout().then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "authed-fetch") {
    // Generic authenticated proxy: { type, path, options }
    authManager.authedFetch(msg.path, msg.options || {}).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  }
});

async function handleChat(msg) {
  if (!await checkRateLimit()) {
    throw new Error("Rate limit exceeded. Please wait a minute before sending another request.");
  }

  let { selectedText, mode, sessionId } = msg;

  // Fix 2 — Input Validation: guard selectedText before any ML pipeline call.
  // tfidfVector called on undefined/null crashed the embedder silently.
  const hasText = typeof selectedText === "string" && selectedText.trim().length > 0;

  if (!sessionId) {
    const storage = await chrome.storage.local.get("active_session_id");
    if (storage.active_session_id) {
      sessionId = storage.active_session_id;
    } else {
      sessionId = await createSession("General", "Study");
      await chrome.storage.local.set({ active_session_id: sessionId });
    }
  }

  const providers = await getEnabledProviders();
  if (providers.length === 0) {
    const snippet = hasText ? selectedText.trim().slice(0, 120) : "Selected text context";
    const modeTitle = (mode || "explain").replace("_", " ");
    return {
      text: `[Bubble AI Note - Offline Mode]\n\nAnalysis for (${modeTitle}):\n• Context snippet: "${snippet}${hasText && selectedText.trim().length > 120 ? "..." : ""}"\n• Summary: Key terms and concepts extracted from active context.\n\nTo enable live AI inference using Gemini, Groq, or OpenAI, enter your free API key in Extension Settings.`,
      providerUsed: "Local Engine",
      fellBack: true
    };
  }

  // 1. Load memory
  const memoryJson = await loadMemory(sessionId);
  let memory = StudyMemory.fromJson(memoryJson);

  // 2. ML Pipeline — only runs when selectedText is a valid non-empty string
  let suggestedMode = mode;
  let topicId = 1;
  let embedding = null;

  if (hasText) {
    try {
      // a. Embed
      embedding = embedder.tfidfVector(selectedText);

      // b. Cluster
      const topic = await clusterer.fit(embedding, selectedText);
      topicId = topic.id;

      // c. Mode classify (only when mode is unspecified or "auto")
      if (!mode || mode === "auto") {
        const cls = modeClassifier.classify(selectedText);
        suggestedMode = cls.mode;
      }
    } catch (mlErr) {
      // ML pipeline failures must never block the AI response.
      // Log and continue with defaults (topicId=1, suggestedMode=mode).
      console.warn("[Bubble SW] ML pipeline error (non-fatal):", mlErr.message);
    }
  }

  // 3. Build Prompt
  const actualMode = suggestedMode || "explain";
  const { system, user } = buildPrompt(actualMode, selectedText, memory.compactJson());
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  // 4. Route
  const response = await route(messages, actualMode, providers, false);

  // 5. Update state — safe: embedding may be null if ML failed, use user prompt as fallback
  const embeddingInput = hasText ? selectedText : user;
  try {
    const storeEmbedding = embedding || embedder.tfidfVector(embeddingInput);
    await memoryStore.add(storeEmbedding, topicId, embeddingInput, actualMode);
  } catch (storeErr) {
    console.warn("[Bubble SW] memoryStore.add failed (non-fatal):", storeErr.message);
  }

  // Difficulty signals (heuristic)
  const isFollowUp = !hasText;
  const isQuiz = actualMode === "quiz_me";
  try {
    await difficultyModel.updateSignals(topicId, { isFollowUp, isHint: false, isQuiz, isQuizCorrect: true });
  } catch (diffErr) {
    console.warn("[Bubble SW] difficultyModel.updateSignals failed (non-fatal):", diffErr.message);
  }

  const exchangeCount = await incrementExchange(sessionId);

  // 6. Fix 3 — Memory Compression with explicit error recovery
  //
  // The previous pattern was fire-and-forget: `.catch(console.error)`.
  // If compressMemory fails (API timeout, rate limit on compression provider),
  // the session's raw memory was left in an uncompressed state indefinitely —
  // meaning future exchanges would re-trigger compression against a still-dirty state.
  //
  // Fix: track a compression_pending flag in chrome.storage.session. If the flag
  // is still set on the next exchange, retry compression before proceeding.
  if (exchangeCount % COMPRESS_EVERY_N === 0) {
    try {
      await chrome.storage.session.set({ [`compress_pending_${sessionId}`]: true });
    } catch (_) {}

    compressMemory(sessionId, memoryJson, { user: hasText ? selectedText : user, ai: response.text }, async (msgs, jsonReq) => {
      const groq = providers.find(p => p.name === "groq") || providers[0];
      const res = await route(msgs, "make_notes", [groq], jsonReq);
      return res.text;
    })
    .then(async () => {
      // Compression succeeded — clear the pending flag
      try {
        await chrome.storage.session.remove(`compress_pending_${sessionId}`);
      } catch (_) {}
    })
    .catch(async (compErr) => {
      // Compression failed — flag remains set; next exchange will retry
      console.warn("[Bubble SW] Memory compression failed, will retry next exchange:", compErr.message);
    });
  } else {
    // Check if a previous compression attempt failed and retry now
    let pendingFlag = false;
    try {
      const flagData = await chrome.storage.session.get(`compress_pending_${sessionId}`);
      pendingFlag = !!flagData[`compress_pending_${sessionId}`];
    } catch (_) {}

    if (pendingFlag) {
      console.log("[Bubble SW] Retrying previously failed memory compression for session:", sessionId);
      compressMemory(sessionId, memoryJson, { user: hasText ? selectedText : user, ai: response.text }, async (msgs, jsonReq) => {
        const groq = providers.find(p => p.name === "groq") || providers[0];
        const res = await route(msgs, "make_notes", [groq], jsonReq);
        return res.text;
      })
      .then(async () => {
        try { await chrome.storage.session.remove(`compress_pending_${sessionId}`); } catch (_) {}
      })
      .catch(compErr => {
        console.warn("[Bubble SW] Retry compression also failed:", compErr.message);
      });
    }
  }

  // 7. Log Usage
  const tokensEst = estimateTokens(system) + estimateTokens(user) + estimateTokens(response.text);
  await logUsage(response.providerUsed, true, tokensEst);

  return {
    text: response.text,
    providerUsed: response.providerUsed,
    fellBack: response.fellBack
  };
}

async function handleProviderStatus() {
  const data = await chrome.storage.local.get(["raw_key_gemini", "raw_key_groq", "raw_key_openai"]);
  const statusList = [];

  const usage = await getProviderUsageToday();

  if (data.raw_key_gemini) {
    const healthy = await checkGeminiHealth(data.raw_key_gemini);
    statusList.push({ name: "gemini", hasKey: true, healthy, requests_today: usage["gemini"] || 0 });
  }
  if (data.raw_key_groq) {
    const healthy = await checkGroqHealth(data.raw_key_groq);
    statusList.push({ name: "groq", hasKey: true, healthy, requests_today: usage["groq"] || 0 });
  }
  if (data.raw_key_openai) {
    const healthy = await checkOpenAIHealth(data.raw_key_openai);
    statusList.push({ name: "openai", hasKey: true, healthy, requests_today: usage["openai"] || 0 });
  }

  return statusList;
}
