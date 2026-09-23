"""
Auto-routes an incoming query to one of Bubble's modes (Explain, Notes,
Quiz, Exam) without the user picking manually.

Needs no labeled training set: each mode gets a handful of hand-written
seed phrases, we embed those, and classification is just "which mode's
seed centroid is this query closest to." This is nearest-centroid
classification, not a trained classifier — you can add a new mode by
adding seed phrases for it, no retraining step.

If mode-selection accuracy matters more than setup simplicity later,
swap this for a small supervised classifier trained on logged
(query, mode_user_actually_picked) pairs — the Embedder interface stays
the same either way.
"""

from __future__ import annotations
import numpy as np
try:
    from .embeddings import Embedder
except ImportError:  # running as a flat script rather than a package
    from embeddings import Embedder

SEED_PHRASES: dict[str, list[str]] = {
    "explain": [
        "what does this mean",
        "I don't understand this part",
        "can you explain this in simpler terms",
        "why does this happen",
        "wait what is this",
    ],
    "notes": [
        "summarize this",
        "give me notes on this",
        "condense this into key points",
        "write a summary",
    ],
    "quiz": [
        "quiz me on this",
        "test my knowledge",
        "give me practice questions",
        "ask me questions about this",
    ],
    "exam": [
        "solve this problem",
        "show the worked answer",
        "walk through this exam question",
        "what's the full solution",
    ],
}


class ModeClassifier:
    def __init__(self, embedder: Embedder):
        self._embedder = embedder
        self._centroids: dict[str, np.ndarray] = {}

    def fit(self) -> None:
        all_texts = [t for texts in SEED_PHRASES.values() for t in texts]
        self._embedder.fit(all_texts)
        for mode, texts in SEED_PHRASES.items():
            vecs = self._embedder.embed(texts)
            centroid = vecs.mean(axis=0)
            norm = np.linalg.norm(centroid)
            self._centroids[mode] = centroid / norm if norm > 0 else centroid

    def classify(self, query: str) -> tuple[str, float]:
        """Returns (mode, confidence). Confidence is cosine similarity to
        the winning centroid — low confidence (e.g. < 0.15 with TF-IDF,
        since short queries share little vocabulary with seed phrases) is
        a signal to fall back to whatever mode the user last used, or to
        just ask, rather than guessing."""
        if not self._centroids:
            self.fit()
        vec = self._embedder.embed([query])[0]
        sims = {mode: float(np.dot(vec, c)) for mode, c in self._centroids.items()}
        best_mode = max(sims, key=sims.get)
        return best_mode, sims[best_mode]
