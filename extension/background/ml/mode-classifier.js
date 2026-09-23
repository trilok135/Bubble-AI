import { embedder } from "./tfidf.js";

const SEED_PHRASES = {
  explain:       ["what is", "explain", "how does", "describe", "tell me about", "what does it mean"],
  make_notes:    ["make notes", "key points", "summarize", "bullet points", "notes", "write notes", "note down", "extract notes"],
  quiz_me:       ["quiz", "test me", "questions", "practice questions", "ask me a question"],
  exam:          ["exam", "long answer", "detailed", "in depth", "comprehensive", "test my knowledge deeply"],
  simple_explain:["simplify", "eli5", "simple", "beginner", "layman", "dumb it down"],
  code_explain:  ["code", "function", "class", "algorithm", "debug", "what does this code do", "explain this code"],
  "2mark":       ["2 mark", "short answer", "brief", "define", "what is briefly"],
  longform:      ["longform", "essay", "elaborate", "write a long essay on"]
};

export class ModeClassifier {
  constructor() {
    this.modeCentroids = {};
    this.isInitialized = false;
  }

  // Deterministic keyword signals. Runs before/alongside the TF-IDF centroid
  // match: if a user explicitly says "quiz me" or "eli5", we should honor that
  // even when the embedding match is weak (short queries vectorize poorly).
  static KEYWORD_HINTS = [
    ["quiz_me", ["quiz", "test me", "practice questions", "ask me a question"]],
    ["make_notes", ["make notes", "key points", "summarize", "bullet points", "write notes", "note down", "extract notes"]],
    ["simple_explain", ["simplify", "eli5", "dumb it down", "for a beginner", "layman"]],
    ["code_explain", ["explain this code", "what does this code do", "debug", "this function", "this algorithm"]],
    ["2mark", ["2 mark", "two marks", "brief", "short answer"]],
    ["exam", ["exam", "long answer", "comprehensive", "in depth"]],
    ["longform", ["essay", "elaborate", "longform", "write a long essay"]],
  ];

  static _keywordHint(text) {
    const t = text.toLowerCase();
    for (const [mode, phrases] of ModeClassifier.KEYWORD_HINTS) {
      if (phrases.some(p => t.includes(p))) return mode;
    }
    return null;
  }

  _init() {
    if (this.isInitialized) return;
    
    // Ensure embedder is fitted
    if (!embedder.isFitted) embedder.fit();

    for (const [mode, phrases] of Object.entries(SEED_PHRASES)) {
      // Calculate centroid for the mode
      let centroid = null;
      let count = 0;
      
      for (const phrase of phrases) {
        const vec = embedder.tfidfVector(phrase);
        if (!centroid) {
          centroid = [...vec];
        } else {
          for (let i = 0; i < vec.length; i++) {
            centroid[i] += vec[i];
          }
        }
        count++;
      }
      
      // Average and re-normalize
      if (centroid && count > 0) {
        let sqSum = 0;
        for (let i = 0; i < centroid.length; i++) {
          centroid[i] /= count;
          sqSum += centroid[i] * centroid[i];
        }
        if (sqSum > 0) {
          const norm = Math.sqrt(sqSum);
          for (let i = 0; i < centroid.length; i++) {
            centroid[i] /= norm;
          }
        }
        this.modeCentroids[mode] = centroid;
      }
    }
    
    this.isInitialized = true;
  }

  classify(queryText) {
    this._init();
    
    if (!queryText || queryText.trim() === "") {
       return { mode: "explain", confidence: 0 }; // default fallback
    }

    // Deterministic keyword pass wins first — user intent phrases like
    // "quiz me" are unambiguous and must not be lost to embedding noise.
    const hint = ModeClassifier._keywordHint(queryText);
    if (hint) {
      return { mode: hint, confidence: 1.0, via: "keyword" };
    }

    const queryVec = embedder.tfidfVector(queryText);
    
    let bestMode = "explain";
    let maxSim = -Infinity;
    
    for (const [mode, centroid] of Object.entries(this.modeCentroids)) {
      const sim = embedder.constructor.cosineSimilarity(queryVec, centroid);
      if (sim > maxSim) {
        maxSim = sim;
        bestMode = mode;
      }
    }
    
    // If confidence is very low, we could optionally fallback to "explain"
    // But returning the max is fine.
    return { mode: bestMode, confidence: maxSim };
  }
}

export const modeClassifier = new ModeClassifier();
