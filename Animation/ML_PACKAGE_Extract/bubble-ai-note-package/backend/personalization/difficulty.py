"""
Per-topic "how well does this user understand this" scoring.

Two tiers, deliberately:

1. A rule-based score that works from interaction #1, with zero cold-start
   problem. This is what actually runs at first.
2. An online logistic regression (SGDClassifier with partial_fit) that
   starts shadowing the rule-based score once there's enough labeled
   signal (quiz results give a clean 0/1 label), and can eventually
   replace it. It never needs a training pipeline or a retraining job —
   it updates one interaction at a time.

Signals tracked per topic, all cheap to log from normal usage — nothing
here requires the user to self-report their skill level:
- follow_up_rate: fraction of explanations that got an immediate
  "wait, what does X mean" follow-up (struggling signal)
- hint_rate: fraction of quiz questions where a hint was requested
- quiz_accuracy: correct / attempted on quiz mode
- avg_time_to_response: how long between the material appearing and the
  user asking about it (fast questions on hard material can mean
  confidence; slow ones can mean confusion — used as a weak signal, not
  a strong one, since it's ambiguous on its own)
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from sklearn.linear_model import SGDClassifier


@dataclass
class TopicSignals:
    follow_ups: int = 0
    explanations_given: int = 0
    hints_requested: int = 0
    quiz_correct: int = 0
    quiz_attempted: int = 0

    @property
    def follow_up_rate(self) -> float:
        return self.follow_ups / self.explanations_given if self.explanations_given else 0.0

    @property
    def hint_rate(self) -> float:
        return self.hints_requested / self.quiz_attempted if self.quiz_attempted else 0.0

    @property
    def quiz_accuracy(self) -> float:
        return self.quiz_correct / self.quiz_attempted if self.quiz_attempted else 0.5  # unknown = assume mid


def rule_based_struggle_score(signals: TopicSignals) -> float:
    """0 = confident/mastered, 1 = actively struggling. Weighted blend,
    weights are a starting point — tune once you have real usage data."""
    score = (
        0.40 * signals.follow_up_rate
        + 0.25 * signals.hint_rate
        + 0.35 * (1.0 - signals.quiz_accuracy)
    )
    return float(np.clip(score, 0.0, 1.0))


class OnlineDifficultyModel:
    """
    Learns to predict "will this user struggle with this topic" from the
    same features as the rule-based score, using quiz correctness as the
    training label. Falls back to the rule-based score until it has seen
    enough labeled examples to be more trustworthy than a hand-tuned guess.
    """

    def __init__(self, min_examples_before_trusting: int = 25):
        self.model = SGDClassifier(loss="log_loss", warm_start=True)
        self.min_examples_before_trusting = min_examples_before_trusting
        self.n_seen = 0
        self._classes_seen = set()

    @staticmethod
    def _features(signals: TopicSignals) -> np.ndarray:
        return np.array([[signals.follow_up_rate, signals.hint_rate, signals.quiz_accuracy]])

    def observe_quiz_result(self, signals: TopicSignals, was_correct: bool) -> None:
        """Call this every time a quiz question is graded — one online
        update, no batch retraining."""
        x = self._features(signals)
        y = np.array([0 if was_correct else 1])  # 1 = struggled
        self._classes_seen.add(int(y[0]))
        if len(self._classes_seen) < 2:
            # SGDClassifier needs to see both classes before its first
            # partial_fit call; rule-based score covers this window.
            self.n_seen += 1
            return
        self.model.partial_fit(x, y, classes=np.array([0, 1]))
        self.n_seen += 1

    def struggle_score(self, signals: TopicSignals) -> float:
        if self.n_seen < self.min_examples_before_trusting or len(self._classes_seen) < 2:
            return rule_based_struggle_score(signals)
        proba = self.model.predict_proba(self._features(signals))[0][1]
        return float(proba)


def difficulty_band(score: float) -> str:
    """Turns the 0-1 score into the label the explanation-depth logic
    actually branches on."""
    if score < 0.25:
        return "confident"
    if score < 0.55:
        return "developing"
    return "struggling"
