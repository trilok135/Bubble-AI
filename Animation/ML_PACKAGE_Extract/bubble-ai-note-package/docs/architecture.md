# Bubble AI Note — Structural Architecture

## 1. Core Concept

A persistent floating AI companion for Chrome that differentiates itself from
built-in assistants (e.g. "Ask Gemini") not by being a bigger model, but by
being a model that **remembers and adapts to the user across sessions**
without requiring manual setup.

---

## 2. Extension Layer (Chrome, Manifest V3)

| Component | Role |
|---|---|
| Content script | Injected into any page; reads selected text, renders the floating bubble UI, reads on-screen context |
| Background service worker | Handles API calls, message routing between components, periodic jobs (e.g. memory compression) |
| Side Panel / Popup UI | Bubble interface surface; Side Panel API preferred over a floating div to avoid CSS conflicts with host pages |
| `chrome.storage.local` | Lightweight persistent state (user profile, settings) |
| `chrome.contextMenus` | Right-click → "Ask Bubble about this" |
| `chrome.alarms` | Triggers periodic background jobs (e.g. the 5-exchange memory compression cycle) |

**Constraints:** Content scripts are DOM-sandboxed from host page JS. Service
workers are non-persistent — no long-lived in-memory state; everything must
persist to storage. Cross-origin calls require declared `host_permissions`.

---

## 3. Personalization Layer (Local, Zero-Cost ML)

This layer runs entirely on-device / on the FastAPI backend with **no
external API calls and no billing exposure**.

| Task | Method | Notes |
|---|---|---|
| Topic/interest clustering | `sentence-transformers` (e.g. MiniLM) embeddings + k-means (scikit-learn) | Detects recurring topics without the user labeling anything |
| Retrieval from study memory | Cosine similarity over stored embeddings (SQLite, optionally `sqlite-vec`) | Poor-man's RAG — pulls the 2-3 most relevant past memories instead of blind chronological context |
| Difficulty/level estimation | Rule-based counter or lightweight logistic regression on logged interaction features | Flags beginner vs. advanced per topic, adjusts explanation depth |
| Auto mode-selection | Local classifier (naive Bayes / keyword features) on the incoming query | Routes to Explain / Notes / Quiz / Exam mode without the user picking manually |

This is the layer that makes the product feel personalized — and it costs
$0 regardless of usage volume.

---

## 4. Generation Layer (LLM Provider Router)

The only layer that actually requires an external API call is final answer
generation. Provider-agnostic router with fallback chain:

1. **Groq (primary)** — fastest inference, free tier, no card required.
   Chosen primary because response speed is a core UX property of an
   always-present floating bubble.
2. **Gemini free tier (fallback)** — native multimodal (useful for future
   PDF/image support), no card required, but rate limits are opaque/tiered.
3. **OpenRouter free models (tertiary/safety net)** — widest model
   flexibility, but most rate-limited (20 req/min flat on free pool).

**Explicit constraint:** only legitimate free access is used — official free
tiers, user-supplied API keys, or local/open-source models. No bypassing
provider restrictions.

**Optional offline mode:** local models via Ollama (e.g. Llama 3.2 3B,
Phi-3 mini) as a privacy/offline toggle. Lower answer quality and higher
device resource demand — not the default path, but available for users who
want zero external calls even for generation.

---

## 5. Cost Model Summary

| Layer | Cost |
|---|---|
| Personalization / learning (clustering, embeddings, retrieval, scoring) | $0 — fully local |
| Answer generation | $0 on free tiers (Groq → Gemini → OpenRouter fallback chain) |
| Optional offline generation | $0 — local model, trades quality/performance for zero network dependency |

---

## 6. Backend / Data

- **FastAPI** backend — hosts the provider router, personalization jobs, and
  memory compression logic
- **SQLite** — persistence layer, Fernet-based key protection
- Memory compression runs roughly every 5 exchanges to keep active context
  small and cheap
- Planned upgrade path: Postgres + React/TS/Tailwind frontend post-MVP

---

## 7. Modes (MVP)

Explain, Notes, Quiz, Exam Answers, plus additional modes — 8 total in the
MVP scope, with PDF mode, flashcards, and vector search deferred post-MVP.
