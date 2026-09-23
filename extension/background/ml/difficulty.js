import { loadUserProfile, saveUserProfile } from "../db/indexeddb.js";

// Weights for the rule-based approach
const WEIGHT_FOLLOW_UP = 0.40;
const WEIGHT_HINT = 0.25;
const WEIGHT_ACCURACY = 0.35;

export class OnlineDifficultyModel {
  constructor() {
    // SGD weights + bias. We only use this if we have > 25 labeled examples, 
    // but for the extension, we'll stick to the rule-based approach initially, 
    // and seamlessly fall back to it since true labeled examples (where user explicitly says they struggled)
    // are rare without a complex UI.
    // However, as per spec, we implement the math.
    
    this.weights = [0, 0, 0]; // [followUp, hint, accuracy]
    this.bias = 0;
    this.learningRate = 0.01;
    this.samplesSeen = 0;
    
    // Track topic signals in memory (ideally this should be persisted too, but we can compute it on the fly or just keep it simple)
    this.topicSignals = {}; // topicId -> { followUpCount, hintCount, quizCorrect, quizTotal, totalExchanges }
  }

  // Helper to clip values
  _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Exact Python formula
  ruleBasedScore(signals) {
    const followUpRate = this._clamp(signals.followUpRate || 0, 0, 1);
    const hintRate = this._clamp(signals.hintRate || 0, 0, 1);
    const quizAccuracy = this._clamp(signals.quizAccuracy || 1.0, 0, 1); // default 1.0 if no quizzes

    const score = (WEIGHT_FOLLOW_UP * followUpRate) +
                  (WEIGHT_HINT * hintRate) +
                  (WEIGHT_ACCURACY * (1.0 - quizAccuracy));
    
    return this._clamp(score, 0.0, 1.0);
  }

  difficultyBand(score) {
    if (score < 0.25) return "confident";
    if (score < 0.55) return "developing";
    return "struggling";
  }

  // Mini online logistic regression (SGD)
  partialFit(features, label) {
    // features: [followUpRate, hintRate, (1.0 - quizAccuracy)]
    // label: 1 (struggled) or 0 (did not struggle)
    
    // Forward pass
    let z = this.bias;
    for (let i = 0; i < this.weights.length; i++) {
      z += this.weights[i] * features[i];
    }
    
    // Sigmoid
    const prediction = 1.0 / (1.0 + Math.exp(-z));
    
    // Gradient descent step
    const error = prediction - label;
    
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] -= this.learningRate * error * features[i];
    }
    this.bias -= this.learningRate * error;
    
    this.samplesSeen++;
  }

  predict(features) {
    if (this.samplesSeen < 25) {
      // Fallback to rule-based if not enough samples
      return this.ruleBasedScore({
        followUpRate: features[0],
        hintRate: features[1],
        quizAccuracy: 1.0 - features[2] // reverse feature back to accuracy
      });
    }
    
    let z = this.bias;
    for (let i = 0; i < this.weights.length; i++) {
      z += this.weights[i] * features[i];
    }
    return 1.0 / (1.0 + Math.exp(-z));
  }

  async updateSignals(topicId, signalsObj) {
    if (!this.topicSignals[topicId]) {
      this.topicSignals[topicId] = { followUpCount: 0, hintCount: 0, quizCorrect: 0, quizTotal: 0, totalExchanges: 0 };
    }
    
    const sig = this.topicSignals[topicId];
    
    if (signalsObj.isFollowUp) sig.followUpCount++;
    if (signalsObj.isHint) sig.hintCount++;
    if (signalsObj.isQuiz) {
      sig.quizTotal++;
      if (signalsObj.isQuizCorrect) sig.quizCorrect++;
    }
    sig.totalExchanges++;
    
    // Calculate rates
    const followUpRate = sig.totalExchanges > 0 ? sig.followUpCount / sig.totalExchanges : 0;
    const hintRate = sig.totalExchanges > 0 ? sig.hintCount / sig.totalExchanges : 0;
    const quizAccuracy = sig.quizTotal > 0 ? sig.quizCorrect / sig.quizTotal : 1.0;
    
    const score = this.ruleBasedScore({ followUpRate, hintRate, quizAccuracy });
    
    // Update user profile
    const profile = await loadUserProfile();
    profile.struggleScore = score;
    profile.masteryLevel = this.difficultyBand(score);
    if (!profile.topicsConfidence) profile.topicsConfidence = {};
    profile.topicsConfidence[topicId] = 1.0 - score; // confidence is inverse of struggle
    
    await saveUserProfile(profile);
    
    return score;
  }
}

export const difficultyModel = new OnlineDifficultyModel();
