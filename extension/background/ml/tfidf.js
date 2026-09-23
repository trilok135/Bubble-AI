const MAX_FEATURES = 4096;
const STOP_WORDS = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your",
  "yours", "yourself", "yourselves", "he", "him", "his", "himself", "she",
  "her", "hers", "herself", "it", "its", "itself", "they", "them", "their",
  "theirs", "themselves", "what", "which", "who", "whom", "this", "that",
  "these", "those", "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an",
  "the", "and", "but", "if", "or", "because", "as", "until", "while", "of",
  "at", "by", "for", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "to", "from", "up", "down",
  "in", "out", "on", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "s", "t", "can", "will",
  "just", "don", "should", "now"
]);

// Seed corpus to pre-warm the IDF vocabulary (like sklearn's fit)
// NOTE: includes intent vocabulary from the mode classifier's SEED_PHRASES
// (mode-classifier.js). Without it, queries like "quiz me on chapter 3" tokenize
// to zero in-vocabulary terms -> all-zero vector -> cosine similarity 0 for every
// mode centroid -> classify() silently degrades to the first entry ("explain").
const SEED_CORPUS = [
  "what is machine learning and artificial intelligence",
  "how to write a python function or class",
  "explain the theory of relativity by albert einstein",
  "summary of world war 2 causes and consequences",
  "what are the differences between mitosis and meiosis",
  "describe the water cycle and precipitation",
  "what is the capital of france and its history",
  "explain newtons laws of motion in physics",
  "how does photosynthesis work in plants",
  "summary of the plot of hamlet by shakespeare",
  // intent vocabulary so classifier queries never produce zero vectors
  "quiz me test me with practice questions",
  "make notes key points summarize bullet points write notes",
  "simplify eli5 simple beginner layman dumb it down",
  "exam long answer detailed in depth comprehensive",
  "essay elaborate write a long essay on",
  "code function class algorithm debug explain this code",
  "2 mark short answer brief define",
  "tell me about describe how does what does it mean"
];

class TfidfEmbedder {
  constructor() {
    this.vocabulary = {}; // term -> index
    this.idf = []; // index -> idf value
    this.isFitted = false;
    this.documentCount = 0;
    this.documentFrequencies = {}; // term -> count
  }

  tokenize(text) {
    if (!text) return [];
    
    // Lowercase and strip punctuation
    const cleanText = text.toLowerCase().replace(/[^\w\s]|_/g, " ").replace(/\s+/g, " ").trim();
    const words = cleanText.split(" ");
    
    // Remove stop words and empty strings
    const validWords = words.filter(w => w.length > 0 && !STOP_WORDS.has(w));
    
    // Unigrams and Bigrams
    const tokens = [...validWords];
    for (let i = 0; i < validWords.length - 1; i++) {
      tokens.push(`${validWords[i]} ${validWords[i+1]}`);
    }
    return tokens;
  }

  computeTF(tokens) {
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    // Convert to frequency (count / total_terms_in_doc)
    // Actually sklearn uses raw counts for tf in tf-idf. We'll stick to counts for simplicity.
    return tf;
  }

  fit(texts = SEED_CORPUS) {
    this.documentFrequencies = {};
    this.documentCount = texts.length;

    for (const text of texts) {
      const tokens = this.tokenize(text);
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        this.documentFrequencies[token] = (this.documentFrequencies[token] || 0) + 1;
      }
    }

    this._buildIdfMap();
    this.isFitted = true;
  }

  partialRefit(newTexts) {
    if (!this.isFitted) {
      this.fit(newTexts);
      return;
    }
    
    this.documentCount += newTexts.length;
    for (const text of newTexts) {
      const tokens = this.tokenize(text);
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        this.documentFrequencies[token] = (this.documentFrequencies[token] || 0) + 1;
      }
    }
    this._buildIdfMap();
  }

  _buildIdfMap() {
    // Sort terms by frequency descending to keep MAX_FEATURES
    const entries = Object.entries(this.documentFrequencies);
    entries.sort((a, b) => b[1] - a[1]);
    
    const topEntries = entries.slice(0, MAX_FEATURES);
    
    this.vocabulary = {};
    this.idf = [];
    
    for (let i = 0; i < topEntries.length; i++) {
      const [term, df] = topEntries[i];
      this.vocabulary[term] = i;
      
      // sklearn smooth idf: log((N+1)/(df+1)) + 1
      const idfVal = Math.log((this.documentCount + 1) / (df + 1)) + 1;
      this.idf.push(idfVal);
    }
  }

  tfidfVector(text) {
    if (!this.isFitted) this.fit();
    
    const tokens = this.tokenize(text);
    const tf = this.computeTF(tokens);
    
    const vec = new Array(Object.keys(this.vocabulary).length).fill(0);
    let sqSum = 0;
    
    for (const [term, count] of Object.entries(tf)) {
      if (term in this.vocabulary) {
        const idx = this.vocabulary[term];
        const val = count * this.idf[idx];
        vec[idx] = val;
        sqSum += val * val;
      }
    }
    
    // L2 Normalization
    if (sqSum > 0) {
      const norm = Math.sqrt(sqSum);
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }
    
    return vec;
  }

  static cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    // Assume vectors are already L2 normalized
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    return dotProduct;
  }
}

export const embedder = new TfidfEmbedder();

/**
 * BUG-10 fix: export cosineSimilarity as a standalone named function so
 * callers don't depend on the fragile `embedder.constructor.cosineSimilarity`
 * pattern (breaks if the instance is wrapped, mocked, or replaced).
 */
export function cosineSimilarity(vecA, vecB) {
  return TfidfEmbedder.cosineSimilarity(vecA, vecB);
}
