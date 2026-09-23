"""
Runs the whole personalization pipeline against a simulated interaction
history, so you can see what it actually produces before wiring it into
the real extension. No API keys, no network calls, no external model
download — everything here runs on TF-IDF + scikit-learn.
"""

from __future__ import annotations
import tempfile
import os
import numpy as np

from embeddings import TfidfEmbedder
from topic_clustering import OnlineTopicClusterer
from difficulty import TopicSignals, rule_based_struggle_score, OnlineDifficultyModel, difficulty_band
from mode_classifier import ModeClassifier
from retrieval import MemoryStore, MemoryEntry
from storage import PersonalizationStore


# A simulated session: a student bouncing between two real topics
# (Magento indexing, React hooks) with different struggle levels.
SIMULATED_INTERACTIONS = [
    ("explain", "what does reindexing on save mean in Magento"),
    ("explain", "wait what is a full page cache invalidation"),
    ("quiz", "quiz me on Magento indexers", False),
    ("explain", "why does useEffect run twice in React"),
    ("explain", "what is a dependency array in useEffect"),
    ("quiz", "test me on React hooks", True),
    ("explain", "wait I still don't get cache invalidation"),
    ("quiz", "another Magento indexer question", False),
    ("quiz", "another React hooks question", True),
    ("notes", "summarize what we covered on React hooks"),
]


def main() -> None:
    embedder = TfidfEmbedder()
    # Fit vocabulary on the full session text up front (in production,
    # call partial_refit every ~5 exchanges instead, on the same cadence
    # as memory compression).
    all_texts = [row[1] for row in SIMULATED_INTERACTIONS]
    embedder.fit(all_texts)

    clusterer = OnlineTopicClusterer(similarity_threshold=0.15)
    mode_clf = ModeClassifier(TfidfEmbedder())
    mode_clf.fit()

    memory = MemoryStore()

    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "test.db")
        store = PersonalizationStore(db_path=db_path)

        topic_signals: dict[int, TopicSignals] = {}
        difficulty_model = OnlineDifficultyModel(min_examples_before_trusting=3)

        print("=== Processing interaction stream ===\n")
        for row in SIMULATED_INTERACTIONS:
            mode, text = row[0], row[1]
            quiz_correct = row[2] if len(row) > 2 else None

            embedding = embedder.embed([text])[0]
            topic = clusterer.assign(embedding, text)
            signals = topic_signals.setdefault(topic.id, TopicSignals())

            if mode == "explain":
                signals.explanations_given += 1
                if "wait" in text.lower() or "still don't" in text.lower():
                    signals.follow_ups += 1
            elif mode == "quiz":
                signals.quiz_attempted += 1
                if quiz_correct:
                    signals.quiz_correct += 1
                difficulty_model.observe_quiz_result(signals, was_correct=bool(quiz_correct))

            score = difficulty_model.struggle_score(signals)
            band = difficulty_band(score)

            store.save_interaction(text, embedding, topic.id, mode)
            store.upsert_topic(topic.id, topic.centroid, topic.interaction_count, score)
            memory.add(MemoryEntry(text=text, embedding=embedding, topic_id=topic.id, mode=mode))

            predicted_mode, confidence = mode_clf.classify(text)

            print(f"[{mode:7s}] \"{text}\"")
            print(f"          -> topic #{topic.id} ({topic.label()!r}), "
                  f"struggle={score:.2f} ({band}), "
                  f"auto-mode-guess={predicted_mode} ({confidence:.2f})")

        print("\n=== Topic summary ===")
        for topic in clusterer.top_topics():
            signals = topic_signals[topic.id]
            score = difficulty_model.struggle_score(signals)
            print(f"Topic #{topic.id} — {topic.interaction_count} interactions — "
                  f"struggle={score:.2f} ({difficulty_band(score)}) — e.g. {topic.label()!r}")

        print("\n=== Retrieval test ===")
        query = "I'm confused about Magento caching again"
        query_vec = embedder.embed([query])[0]
        best_topic = clusterer.nearest(query_vec)  # look up only, doesn't mutate the topic
        results = memory.retrieve(query_vec, top_k=2, topic_id=best_topic.id)
        print(f"Query: {query!r}")
        print(f"Retrieved (topic #{best_topic.id}):")
        for r in results:
            print(f"  - {r.text!r} (mode={r.mode})")

        print("\n=== Known limitation, worth reading ===")
        print(
            "This run created more topics than a human would (Magento reindexing,\n"
            "cache invalidation, and 'indexer question' all landed as separate topics)\n"
            "because TF-IDF only sees shared vocabulary, not meaning — 'cache\n"
            "invalidation' and 'caching' don't overlap enough lexically to merge.\n"
            "TF-IDF is the right default for cost/simplicity, but if topic-merging\n"
            "accuracy matters more than zero-download simplicity, swap in\n"
            "SentenceTransformerEmbedder from embeddings.py — nothing else in this\n"
            "pipeline needs to change, since everything is written against the\n"
            "Embedder interface, not against TF-IDF specifically."
        )

        store.close()


if __name__ == "__main__":
    main()
