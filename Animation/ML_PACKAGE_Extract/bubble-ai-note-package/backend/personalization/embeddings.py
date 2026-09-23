"""
Embedding backends for the personalization layer.

Default: TF-IDF (scikit-learn). Zero network calls, zero model download,
works the moment it's installed. Good enough for clustering "what topics
does this user keep asking about" and nearest-neighbor memory retrieval —
it doesn't need to understand meaning, just which past questions are
lexically close to the current one.

Upgrade path: SentenceTransformerEmbedder, for when semantic similarity
matters more than shared vocabulary (e.g. "compound interest" and "growth
over time" should cluster together even with no shared words). Requires
`pip install sentence-transformers` and a one-time model download.
"""

from __future__ import annotations
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize


class Embedder:
    """Common interface every embedding backend implements."""

    def fit(self, texts: list[str]) -> None:
        raise NotImplementedError

    def embed(self, texts: list[str]) -> np.ndarray:
        """Returns an (n_texts, dim) L2-normalized float array."""
        raise NotImplementedError

    @property
    def is_fitted(self) -> bool:
        raise NotImplementedError


class TfidfEmbedder(Embedder):
    """
    Default embedder. Refits its vocabulary as new interactions come in
    (call `partial_refit` periodically — e.g. on the same 5-exchange
    cadence as the memory-compression cycle) so it adapts to this specific
    user's vocabulary instead of a fixed generic one.
    """

    def __init__(self, max_features: int = 4096):
        self._vectorizer = TfidfVectorizer(
            max_features=max_features,
            ngram_range=(1, 2),
            stop_words="english",
        )
        self._fitted = False
        self._corpus: list[str] = []

    def fit(self, texts: list[str]) -> None:
        self._corpus = list(texts)
        if len(self._corpus) < 2:
            # TF-IDF needs at least a couple of documents to build a
            # meaningful vocabulary; pad with an empty doc so it doesn't
            # explode on a user's very first interaction.
            self._corpus.append("")
        self._vectorizer.fit(self._corpus)
        self._fitted = True

    def partial_refit(self, new_texts: list[str]) -> None:
        """Extend the corpus and refit. Cheap at the scale of one user's
        interaction history (hundreds to low thousands of short texts)."""
        self._corpus.extend(new_texts)
        self._vectorizer.fit(self._corpus)
        self._fitted = True

    def embed(self, texts: list[str]) -> np.ndarray:
        if not self._fitted:
            self.fit(texts)
        vecs = self._vectorizer.transform(texts).toarray()
        return normalize(vecs)

    @property
    def is_fitted(self) -> bool:
        return self._fitted


class SentenceTransformerEmbedder(Embedder):
    """
    Optional upgrade. Not used by default because it requires a model
    download on first run. Swap this in by changing one line wherever
    an Embedder is constructed — everything downstream (clustering,
    retrieval, mode classification) is written against the Embedder
    interface and doesn't care which backend is behind it.
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer  # lazy import
        self._model = SentenceTransformer(model_name)

    def fit(self, texts: list[str]) -> None:
        pass  # no fitting step needed — the model is pre-trained

    def embed(self, texts: list[str]) -> np.ndarray:
        vecs = self._model.encode(texts, normalize_embeddings=True)
        return np.asarray(vecs)

    @property
    def is_fitted(self) -> bool:
        return True
