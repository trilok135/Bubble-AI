# Personalization Layer

Real, running code for "understand what this user does and doesn't
understand" — the local-ML layer described in `docs/architecture.md`.
Zero API calls, zero billing, zero model download by default. Verified
end-to-end with `demo.py` (run it — `python3 demo.py`, no setup beyond
`pip install -r requirements.txt`).

```
personalization/
├── embeddings.py         Embedding backends: TF-IDF (default) + a
│                          sentence-transformers upgrade path
├── topic_clustering.py   Online "leader clustering" — learns topics as
│                          they appear, no fixed k, no batch refit
├── difficulty.py          Per-topic struggle score: rule-based from
│                          interaction #1, upgrades to an online logistic
│                          regression once enough quiz results exist
├── mode_classifier.py     Auto-routes a query to Explain/Notes/Quiz/Exam
│                          via nearest-centroid over seed phrases
├── retrieval.py            Cosine-similarity memory search (poor-man's RAG)
├── storage.py              SQLite persistence, Fernet-encrypted interaction
│                          text at rest
├── demo.py                 Runs the whole pipeline against a simulated
│                          session — read this first
└── requirements.txt
```

## What each piece actually decides

- **Which topic is this?** `topic_clustering.py` — compares the new
  question's embedding against every known topic's running centroid; folds
  it in if close enough, starts a new topic if not.
- **How well does this user get this topic?** `difficulty.py` — blends
  follow-up rate, hint rate, and quiz accuracy into a 0–1 struggle score,
  banded into confident / developing / struggling.
- **Which mode does this query want?** `mode_classifier.py` — nearest
  seed-phrase centroid, no training data needed.
- **What past context is actually relevant right now?** `retrieval.py` —
  top-k cosine-similarity match, scoped to the current topic.

## The one honest limitation to know before you rely on this

`demo.py`'s own output ends with a section on this, but it's worth
repeating here: **TF-IDF clusters on shared words, not shared meaning.**
In the demo run, "cache invalidation" and "Magento caching" landed as
different topics because they don't share enough vocabulary, even though
a person would call them the same thing. This is the correct trade-off for
a zero-download, zero-cost default — but if topic-merging accuracy starts
mattering more than setup simplicity, swap `TfidfEmbedder` for
`SentenceTransformerEmbedder` in `embeddings.py`. Nothing else changes —
`topic_clustering.py`, `difficulty.py`, `mode_classifier.py`, and
`retrieval.py` are all written against the `Embedder` interface, not
against TF-IDF specifically.

## Wiring this into the FastAPI backend

Each module is framework-agnostic on purpose. The rough integration shape:

1. On every user interaction, compute its embedding, call
   `clusterer.assign(...)` to get/create its topic, and log the relevant
   signal onto that topic's `TopicSignals`.
2. Before generating a response, call `mode_classifier.classify(query)`
   to pick a mode (or default to whatever mode the user manually picked),
   and `memory.retrieve(...)` to pull the 2-3 most relevant past entries
   for the prompt instead of the full conversation history.
3. Use `difficulty_band(...)` to decide explanation depth — a
   "struggling" band means slower down, more scaffolding, an "explain
   again" with a different framing; "confident" means skip the basics.
4. Persist everything through `PersonalizationStore` so it survives
   across sessions (call `partial_refit` on the embedder every ~5
   exchanges, on the same cadence as the existing memory-compression
   cycle).
