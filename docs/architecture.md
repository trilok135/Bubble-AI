# Architecture

Bubble AI is a fully serverless, self-contained Chrome Extension built on Manifest V3.

## Core Components
- **Service Worker (`background/service-worker.js`)**: The brain. Orchestrates IndexedDB, ML logic, and API calls.
- **IndexedDB (`background/db/indexeddb.js`)**: Browser-native storage for sessions, memory, interactions, and usage logs.
- **Client-Side ML (`background/ml/`)**: 
  - `tfidf.js`: In-browser TF-IDF text vectorization.
  - `clustering.js`: Online leader clustering for topic grouping.
  - `difficulty.js`: Rule-based struggle scoring.
  - `mode-classifier.js`: Nearest-centroid classification using embedded seed phrases.
  - `memory.js`: Study memory serialization, JSON compaction, and cosine retrieval.
- **Providers (`background/providers/`)**: Direct HTTP clients to Gemini, Groq, and OpenAI via `fetch`.
- **Router (`background/router.js`)**: Fallback routing across providers.

## Key Storage
- API keys are stored in `chrome.storage.local`.
- Databases and chat logs are stored in IndexedDB.
