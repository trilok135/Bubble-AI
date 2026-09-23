"""
Online topic clustering.

Regular k-means needs to know k (the number of topics) in advance and
needs to be refit on the whole dataset — wrong shape for a stream of
interactions arriving one at a time with no idea how many topics a
student will end up touching.

This uses "leader clustering" instead: for each new interaction, compare
it against every known topic's centroid. If it's close enough to an
existing one, fold it in (nudge that centroid toward the new point). If
it's not close to anything, that's a new topic. It's O(n_topics) per
interaction, which is fine — a single user will realistically accumulate
tens of topics, not thousands.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np


@dataclass
class Topic:
    id: int
    centroid: np.ndarray
    example_texts: list[str] = field(default_factory=list)
    interaction_count: int = 1

    def label(self) -> str:
        """A human-readable stand-in until you generate a real title
        (e.g. by asking an LLM to name the cluster from its examples)."""
        return self.example_texts[0][:48] if self.example_texts else f"topic-{self.id}"


class OnlineTopicClusterer:
    def __init__(self, similarity_threshold: float = 0.42, max_examples_per_topic: int = 5):
        self.similarity_threshold = similarity_threshold
        self.max_examples_per_topic = max_examples_per_topic
        self.topics: list[Topic] = []
        self._next_id = 0

    def assign(self, embedding: np.ndarray, text: str) -> Topic:
        """Assign a new interaction to an existing topic, or create one.
        `embedding` must already be L2-normalized (cosine similarity
        reduces to a dot product in that case)."""
        if self.topics:
            sims = np.array([float(np.dot(embedding, t.centroid)) for t in self.topics])
            best_idx = int(np.argmax(sims))
            if sims[best_idx] >= self.similarity_threshold:
                topic = self.topics[best_idx]
                self._fold_in(topic, embedding, text)
                return topic

        topic = Topic(id=self._next_id, centroid=embedding.copy(), example_texts=[text])
        self._next_id += 1
        self.topics.append(topic)
        return topic

    def _fold_in(self, topic: Topic, embedding: np.ndarray, text: str) -> None:
        # Running average of the centroid, weighted by how many points
        # it's already absorbed — later points move it less.
        n = topic.interaction_count
        topic.centroid = (topic.centroid * n + embedding) / (n + 1)
        norm = np.linalg.norm(topic.centroid)
        if norm > 0:
            topic.centroid /= norm
        topic.interaction_count = n + 1
        if len(topic.example_texts) < self.max_examples_per_topic:
            topic.example_texts.append(text)

    def nearest(self, embedding: np.ndarray) -> Topic | None:
        """Find the closest topic without assigning/folding the point in —
        use this for retrieval queries, where you want to know 'which
        topic is this like' without the query itself becoming part of
        that topic's history."""
        if not self.topics:
            return None
        sims = np.array([float(np.dot(embedding, t.centroid)) for t in self.topics])
        return self.topics[int(np.argmax(sims))]

    def top_topics(self, n: int = 5) -> list[Topic]:
        return sorted(self.topics, key=lambda t: t.interaction_count, reverse=True)[:n]
