"""
Retrieval over a user's own interaction history.

The point: instead of stuffing every past exchange into the LLM's context
(expensive, and eventually hits a limit), pull only the 2-3 past
interactions most relevant to the *current* question. This is exactly what
RAG systems do with a vector database — at one user's scale (hundreds to
low thousands of interactions), a plain in-memory cosine-similarity scan
is faster to build, has no infra to run, and is fast enough in practice.
Swap in sqlite-vec or a real vector DB only if profiling actually shows
this is a bottleneck.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np


@dataclass
class MemoryEntry:
    text: str
    embedding: np.ndarray
    topic_id: int
    mode: str


class MemoryStore:
    def __init__(self):
        self._entries: list[MemoryEntry] = []

    def add(self, entry: MemoryEntry) -> None:
        self._entries.append(entry)

    def retrieve(self, query_embedding: np.ndarray, top_k: int = 3,
                 topic_id: int | None = None) -> list[MemoryEntry]:
        """Returns the top_k most similar past entries. Pass topic_id to
        restrict retrieval to the current topic only — usually what you
        want, since a past note about React hooks isn't useful context
        for a current question about Magento indexing even if the wording
        happens to be superficially similar."""
        candidates = self._entries
        if topic_id is not None:
            candidates = [e for e in candidates if e.topic_id == topic_id]
        if not candidates:
            return []
        sims = np.array([float(np.dot(query_embedding, e.embedding)) for e in candidates])
        top_idx = np.argsort(sims)[::-1][:top_k]
        return [candidates[i] for i in top_idx]
