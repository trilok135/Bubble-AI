// Auto-bundled background script
// --- db/indexeddb.js ---
const DB_NAME = "bubble-ai-db";
const DB_VERSION = 1;

let dbPromise = null;

async function openDB() {
  if (dbPromise) return dbPromise;
  
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains("sessions")) {
        const sessionsOS = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
        sessionsOS.createIndex("createdAt", "createdAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("study_memory")) {
        db.createObjectStore("study_memory", { keyPath: "sessionId" });
      }

      if (!db.objectStoreNames.contains("provider_config")) {
        db.createObjectStore("provider_config", { keyPath: "name" });
      }

      if (!db.objectStoreNames.contains("usage_log")) {
        const usageOS = db.createObjectStore("usage_log", { keyPath: "id", autoIncrement: true });
        usageOS.createIndex("ts", "ts", { unique: false });
        usageOS.createIndex("provider", "provider", { unique: false });
      }

      if (!db.objectStoreNames.contains("user_profile")) {
        db.createObjectStore("user_profile", { keyPath: "userId" });
      }

      if (!db.objectStoreNames.contains("topics")) {
        db.createObjectStore("topics", { keyPath: "id", autoIncrement: true });
      }
      
      if (!db.objectStoreNames.contains("interactions")) {
        const intOS = db.createObjectStore("interactions", { keyPath: "id", autoIncrement: true });
        intOS.createIndex("topicId", "topicId", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      console.error("IndexedDB open error:", event.target.error);
      reject(event.target.error);
    };
  });
  
  return dbPromise;
}

function transaction(storeName, mode, callback) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result = null;

      tx.oncomplete = () => resolve(result);
      tx.onerror = (e) => reject(e.target.error);

      // Execute callback which might make multiple async requests on the store
      // We pass resolve to let the callback manually set the result
      const p = callback(store);
      if (p instanceof Promise) {
          p.then(res => { result = res; }).catch(reject);
      }
    });
  });
}

function now() {
  return new Date().toISOString();
}

// ---------- sessions ----------
async function createSession(subject = null, topic = null) {
  return transaction("sessions", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ subject, topic, createdAt: now(), exchangeCount: 0 });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

async function getSession(sessionId) {
  return transaction("sessions", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.get(sessionId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

async function incrementExchange(sessionId) {
  return transaction("sessions", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.get(sessionId);
      req.onsuccess = () => {
        const session = req.result;
        if (!session) {
            res(0);
            return;
        }
        session.exchangeCount = (session.exchangeCount || 0) + 1;
        const updateReq = store.put(session);
        updateReq.onsuccess = () => res(session.exchangeCount);
        updateReq.onerror = () => rej(updateReq.error);
      };
      req.onerror = () => rej(req.error);
    });
  });
}

// ---------- study memory ----------
async function loadMemory(sessionId) {
  return transaction("study_memory", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.get(sessionId);
      req.onsuccess = () => res(req.result ? req.result.jsonBlob : null);
      req.onerror = () => rej(req.error);
    });
  });
}

async function saveMemory(sessionId, memoryJson) {
  return transaction("study_memory", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.put({ sessionId, jsonBlob: memoryJson, updatedAt: now() });
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  });
}

async function clearMemory(sessionId) {
    return transaction("study_memory", "readwrite", async (store) => {
        return new Promise((res, rej) => {
            const req = store.delete(sessionId);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
        });
    });
}

// ---------- usage ----------
async function logUsage(provider, success, tokensEst) {
  return transaction("usage_log", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ provider, ts: now(), success: success ? 1 : 0, tokensEst });
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  });
}

async function requestsToday(provider) {
  return transaction("usage_log", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const index = store.index("ts");
      const today = now().substring(0, 10); // YYYY-MM-DD
      const range = IDBKeyRange.bound(today + "T00:00:00.000Z", today + "T23:59:59.999Z");
      
      const req = index.openCursor(range);
      let count = 0;
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (cursor.value.provider === provider) {
            count++;
          }
          cursor.continue();
        } else {
          res(count);
        }
      };
      req.onerror = () => rej(req.error);
    });
  });
}

async function getProviderUsageToday() {
  // Returns object with mapping provider -> requests today
  return transaction("usage_log", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const index = store.index("ts");
      const today = now().substring(0, 10);
      const range = IDBKeyRange.bound(today + "T00:00:00.000Z", today + "T23:59:59.999Z");
      
      const req = index.openCursor(range);
      const counts = {};
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const p = cursor.value.provider;
          counts[p] = (counts[p] || 0) + 1;
          cursor.continue();
        } else {
          res(counts);
        }
      };
      req.onerror = () => rej(req.error);
    });
  });
}

// ---------- ML topics & interactions ----------
async function saveInteraction(embedding, topicId, mode) {
  return transaction("interactions", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ embedding, topicId, mode, createdAt: now() });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

async function getInteractionsByTopic(topicId) {
  return transaction("interactions", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const index = store.index("topicId");
      const req = index.getAll(topicId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

async function saveTopics(topics) {
    // Save multiple topics (or single)
    return transaction("topics", "readwrite", async (store) => {
        return new Promise((res, rej) => {
            if (!Array.isArray(topics)) topics = [topics];
            let completed = 0;
            if (topics.length === 0) return res();
            
            for (let i = 0; i < topics.length; i++) {
                const req = store.put(topics[i]);
                req.onsuccess = () => {
                    completed++;
                    if (completed === topics.length) res();
                };
                req.onerror = () => rej(req.error);
            }
        });
    });
}

async function loadTopics() {
  return transaction("topics", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

// ---------- user profile ----------
async function loadUserProfile(userId = "default") {
    return transaction("user_profile", "readonly", async (store) => {
        return new Promise((res, rej) => {
            const req = store.get(userId);
            req.onsuccess = () => {
                if (req.result) {
                    res(req.result);
                } else {
                    res({
                        userId,
                        difficultyPreference: "medium",
                        struggleScore: 0.0,
                        masteryLevel: "beginner",
                        topicsConfidence: {}
                    });
                }
            };
            req.onerror = () => rej(req.error);
        });
    });
}

async function saveUserProfile(profile) {
    return transaction("user_profile", "readwrite", async (store) => {
        return new Promise((res, rej) => {
            const req = store.put(profile);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
        });
    });
}


// --- ml/tfidf.js ---
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

const embedder = new TfidfEmbedder();

/**
 * BUG-10 fix: export cosineSimilarity as a standalone named function so
 * callers don't depend on the fragile `embedder.constructor.cosineSimilarity`
 * pattern (breaks if the instance is wrapped, mocked, or replaced).
 */
function cosineSimilarity(vecA, vecB) {
  return TfidfEmbedder.cosineSimilarity(vecA, vecB);
}


// --- ml/clustering.js ---



const DEFAULT_THRESHOLD = 0.42;

class OnlineTopicClusterer {
  constructor(threshold = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
    this.topics = []; // Array of { id, name, centroid: float[], count: number }
    this.nextId = 1;
    this.isLoaded = false;
  }

  async loadFromDB() {
    if (this.isLoaded) return;
    const dbTopics = await loadTopics();
    this.topics = dbTopics.map(t => ({
      id: t.id,
      name: t.name,
      centroid: t.centroid || [],
      count: t.count || 1
    }));
    if (this.topics.length > 0) {
      this.nextId = Math.max(...this.topics.map(t => t.id)) + 1;
    }
    this.isLoaded = true;
  }

  async fit(embedding, text) {
    await this.loadFromDB();
    
    if (this.topics.length === 0) {
      return this._createNewTopic(embedding, text);
    }

    // Find nearest topic
    const nearest = this.nearest(embedding);
    
    if (nearest && nearest.similarity >= this.threshold) {
      return this._updateTopic(nearest.topic, embedding);
    } else {
      return this._createNewTopic(embedding, text);
    }
  }

  nearest(embedding) {
    if (this.topics.length === 0) return null;
    
    let bestTopic = null;
    let maxSim = -Infinity;
    
    for (const topic of this.topics) {
      const sim = embedder.constructor.cosineSimilarity(embedding, topic.centroid);
      if (sim > maxSim) {
        maxSim = sim;
        bestTopic = topic;
      }
    }
    
    return { topic: bestTopic, similarity: maxSim };
  }

  async _createNewTopic(embedding, text) {
    // Generate a simple name from the text (first 3-5 words)
    const words = text.trim().split(/\s+/).slice(0, 4);
    const name = words.join(" ") + "...";
    
    const newTopic = {
      id: this.nextId++,
      name: name,
      centroid: [...embedding], // copy
      count: 1
    };
    
    this.topics.push(newTopic);
    await saveTopics([{
        id: newTopic.id, 
        name: newTopic.name, 
        centroid: newTopic.centroid, 
        count: newTopic.count
    }]);
    
    return newTopic;
  }

  async _updateTopic(topic, embedding) {
    const n = topic.count;
    
    // Running average: (centroid * n + embedding) / (n + 1)
    let sqSum = 0;
    for (let i = 0; i < topic.centroid.length; i++) {
      topic.centroid[i] = (topic.centroid[i] * n + embedding[i]) / (n + 1);
      sqSum += topic.centroid[i] * topic.centroid[i];
    }
    
    // Re-normalize
    if (sqSum > 0) {
      const norm = Math.sqrt(sqSum);
      for (let i = 0; i < topic.centroid.length; i++) {
        topic.centroid[i] /= norm;
      }
    }
    
    topic.count += 1;
    
    await saveTopics([{
        id: topic.id, 
        name: topic.name, 
        centroid: topic.centroid, 
        count: topic.count
    }]);
    
    return topic;
  }
}

const clusterer = new OnlineTopicClusterer();


// --- ml/difficulty.js ---


// Weights for the rule-based approach
const WEIGHT_FOLLOW_UP = 0.40;
const WEIGHT_HINT = 0.25;
const WEIGHT_ACCURACY = 0.35;

class OnlineDifficultyModel {
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

const difficultyModel = new OnlineDifficultyModel();


// --- ml/mode-classifier.js ---


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

class ModeClassifier {
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

const modeClassifier = new ModeClassifier();


// --- ml/memory.js ---

 // BUG-10: import standalone fn

const MAX_MEMORY_TOKENS = 300;

class StudyMemory {
  constructor(data = {}) {
    this.subject = data.subject || null;
    this.topic = data.topic || null;
    this.user_level = data.user_level || null;
    this.understood = data.understood || [];
    this.needs_clarification = data.needs_clarification || [];
    this.preferred_style = data.preferred_style || null;
  }

  compact() {
    // Keep only last 6 items for list fields
    if (this.understood.length > 6) {
      this.understood = this.understood.slice(-6);
    }
    if (this.needs_clarification.length > 6) {
      this.needs_clarification = this.needs_clarification.slice(-6);
    }
  }

  compactJson() {
    this.compact();
    let jsonStr = JSON.stringify(this);
    
    // Fallback trimming if still too large
    while (estimateTokens(jsonStr) > MAX_MEMORY_TOKENS) {
      if (this.understood.length > 0 && this.needs_clarification.length > 0) {
        if (this.understood.length >= this.needs_clarification.length) {
          this.understood.shift();
        } else {
          this.needs_clarification.shift();
        }
      } else if (this.understood.length > 0) {
        this.understood.shift();
      } else if (this.needs_clarification.length > 0) {
        this.needs_clarification.shift();
      } else {
        // Clear strings if arrays are empty
        this.user_level = null;
        this.preferred_style = null;
        jsonStr = JSON.stringify(this);
        break;
      }
      jsonStr = JSON.stringify(this);
    }
    return jsonStr;
  }

  static fromJson(str) {
    if (!str) return new StudyMemory();
    try {
      const parsed = typeof str === "string" ? JSON.parse(str) : str;
      return new StudyMemory(parsed);
    } catch (e) {
      console.warn("Failed to parse StudyMemory JSON:", e);
      return new StudyMemory();
    }
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  // Heuristic: words + punctuation
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;
  // A rough approximation
  return Math.max(words, Math.ceil(chars / 4));
}

// MemoryStore for Topic-scoped cosine retrieval
class MemoryStore {
  async add(embedding, topicId, text, mode) {
    await saveInteraction(embedding, topicId, mode);
  }

  async topK(queryEmbedding, topicId, k = 3) {
    const interactions = await getInteractionsByTopic(topicId);
    if (!interactions || interactions.length === 0) return [];
    
    // Calculate similarities
    const scored = interactions.map(interaction => {
      // BUG-10 fix: use the exported cosineSimilarity function instead of
      // embedder.constructor.cosineSimilarity (fragile constructor reference).
      const sim = cosineSimilarity(queryEmbedding, interaction.embedding);
      return { ...interaction, similarity: sim };
    });
    
    // Sort descending by similarity
    scored.sort((a, b) => b.similarity - a.similarity);
    
    return scored.slice(0, k);
  }
}

const memoryStore = new MemoryStore();

const COMPRESSION_SYSTEM_PROMPT = `You are a memory compaction agent.
Extract the user's latest understanding, misconceptions, and style preferences from the new exchange.
Merge them into the existing memory JSON.
Return ONLY valid JSON matching this schema:
{
  "subject": "string or null",
  "topic": "string or null",
  "user_level": "string or null",
  "understood": ["point 1", "point 2"],
  "needs_clarification": ["point 1"],
  "preferred_style": "string or null"
}`;

async function compressMemory(sessionId, oldMemoryJson, newExchange, callLLM) {
  const promptText = `
CURRENT MEMORY:
${oldMemoryJson || "{}"}

NEW EXCHANGE:
User: ${newExchange.user}
AI: ${newExchange.ai}

MERGED MEMORY JSON:`;

  const messages = [
    { role: "system", content: COMPRESSION_SYSTEM_PROMPT },
    { role: "user", content: promptText }
  ];

  try {
    const responseText = await callLLM(messages, true); // true = request JSON format if provider supports
    // Extract JSON from response text (handle markdown blocks)
    let jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    let extractedJson = jsonMatch ? jsonMatch[1] : responseText;
    
    // Sanity check parse
    const newMemObj = JSON.parse(extractedJson);
    const newMemory = new StudyMemory(newMemObj);
    const compactStr = newMemory.compactJson();
    
    await saveMemory(sessionId, compactStr);
    return newMemory;
  } catch (e) {
    console.error("Memory compression failed:", e);
    // If it fails, we keep the old memory
    return StudyMemory.fromJson(oldMemoryJson);
  }
}


// --- providers/gemini.js ---
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-flash-latest"; // gemini-2.5-flash closed to new API keys (404); alias matches backend and auto-tracks newest flash

function toGeminiFormat(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = {
        parts: [{ text: msg.content }]
      };
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }

  return { contents, systemInstruction };
}

async function callGemini(apiKey, messages, requestJson = false, maxRetries = 2) {
  const { contents, systemInstruction } = toGeminiFormat(messages);
  
  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.7
    }
  };
  
  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }
  
  if (requestJson) {
    payload.generationConfig.responseMimeType = "application/json";
  }

  const url = `${BASE_URL}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return { text };
      }

      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        // Auth error, bad request, or model not found — do NOT retry, fail fast
        const body = await response.text();
        const err = new Error(`Gemini Error ${response.status}: ${body}`);
        err.fatal = true; // non-retryable: must not be swallowed by the catch below
        throw err;
      }

      // 429 or 5xx, retry with exponential backoff
      console.warn(`Gemini API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
    } catch (e) {
      if (attempt >= maxRetries || e.fatal) {
        throw e;
      }
    }
    
    attempt++;
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  
  throw new Error("Max retries exceeded for Gemini.");
}

async function checkGeminiHealth(apiKey) {
  try {
    const res = await callGemini(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}


// --- providers/groq.js ---
const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b"; // llama-3.3-70b-versatile retired by Groq (404 model_not_found, verified Sep 2026)

async function callGroq(apiKey, messages, requestJson = false, maxRetries = 2) {
  const payload = {
    model: GROQ_DEFAULT_MODEL,
    messages: messages,
    temperature: 0.7
  };

  if (requestJson) {
    payload.response_format = { type: "json_object" };
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(GROQ_BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";
        return { text };
      }

      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        // Auth error, bad request, or model not found — do NOT retry, fail fast
        const body = await response.text();
        const err = new Error(`Groq Error ${response.status}: ${body}`);
        err.fatal = true; // non-retryable: must not be swallowed by the catch below
        throw err;
      }

      console.warn(`Groq API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
    } catch (e) {
      if (attempt >= maxRetries || e.fatal) {
        throw e;
      }
    }
    
    attempt++;
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  
  throw new Error("Max retries exceeded for Groq.");
}

async function checkGroqHealth(apiKey) {
  try {
    const res = await callGroq(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}


// --- providers/openai.js ---
const OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

async function callOpenAI(apiKey, messages, requestJson = false, maxRetries = 2) {
  const payload = {
    model: OPENAI_DEFAULT_MODEL,
    messages: messages,
    temperature: 0.7
  };

  if (requestJson) {
    payload.response_format = { type: "json_object" };
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const response = await fetch(OPENAI_BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || "";
        return { text };
      }

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new Error(`OpenAI Error ${response.status}: ${await response.text()}`);
      }

      console.warn(`OpenAI API returned ${response.status}. Retrying... (${attempt + 1}/${maxRetries})`);
    } catch (e) {
      if (attempt >= maxRetries) {
        throw e;
      }
    }
    
    attempt++;
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  
  throw new Error("Max retries exceeded for OpenAI.");
}

async function checkOpenAIHealth(apiKey) {
  try {
    const res = await callOpenAI(apiKey, [{ role: "user", content: "hi" }], false, 0);
    return !!res.text;
  } catch (e) {
    return false;
  }
}


// --- prompts.js ---
const TEMPLATES = {
  explain: {
    system: `You are an expert tutor. Explain the selected concept clearly and accurately, in a structured way.
Tailor level and style to the student's compact study memory: {study_memory_json}

Structure your answer with a short intro, the core explanation, and a takeaway line. Use short headings.`,
    user: `{selected_text}`
  },
  
  simple_explain: {
    system: `You are a friendly tutor for beginners. Explain the selected text in plain, simple language using everyday analogies.
Assume no prior background unless the study memory says otherwise: {study_memory_json}

Keep it short, warm, and concrete. Avoid jargon; if you must use a term, explain it in parentheses right after.`,
    user: `{selected_text}`
  },
  
  example: {
    system: `You are a tutor who teaches through examples. For the selected concept, provide a concrete, realistic worked example that illustrates it step by step, then a second contrasting example.
Tailor difficulty to the student's study memory: {study_memory_json}

Label each example and explain why it works.`,
    user: `{selected_text}`
  },
  
  code_explain: {
    system: `You are a programming tutor. If the selected text is code, explain it line by line and then summarize the algorithm in plain English.
If it is not code, show a short annotated code snippet that demonstrates the concept and explain the key lines.
Reference the student's study memory to pitch the depth: {study_memory_json}

Use fenced code blocks.`,
    user: `{selected_text}`
  },
  
  "2mark": {
    system: `You are an exam coach. Write the answer a student should give for a 2-mark exam question on the selected topic.
Use exactly two clear points, one sentence each, in exam-style markscheme wording. Then list the markscheme keywords in brackets.
Study memory for context: {study_memory_json}`,
    user: `{selected_text}`
  },
  
  longform: {
    system: `You are a subject expert writing a detailed study explainer. Produce a structured long-form answer: an introduction, numbered sections with subheadings, and a conclusion.
Depth over brevity. Adapt length and difficulty to the student's study memory: {study_memory_json}`,
    user: `{selected_text}`
  },
  
  quiz_me: {
    system: `You are a quiz generator. Based on the selected text and the student's memory ({study_memory_json}),
generate 3 quiz questions of increasing difficulty, each followed by its model answer.
Mark questions targeting known weak areas with [WEAK SPOT]. Number the questions.`,
    user: `{selected_text}`
  },
  
  make_notes: {
    system: `You are a study-note creator. Turn the selected text into clean revision notes: a title, key definitions,
bullet-point summaries, and a boxed "remember" line at the end.
Use the student's study memory ({study_memory_json}) to emphasize gaps and open questions.`,
    user: `{selected_text}`
  }
};

function buildPrompt(mode, selectedText, memoryJson) {
  const template = TEMPLATES[mode] || TEMPLATES.explain;
  
  const system = template.system.replace("{study_memory_json}", memoryJson || "{}");
  const user = template.user.replace("{selected_text}", selectedText || "");
  
  return { system, user };
}


// --- router.js ---




const REASONING_DEPTH = {
  explain: "medium", 
  simple_explain: "medium", 
  example: "medium",
  code_explain: "medium", 
  "2mark": "light", 
  longform: "medium",
  quiz_me: "medium", 
  make_notes: "light",
  exam: "deep",
  deep_dive: "deep",
  practice: "medium"
};

async function route(messages, mode, availableProviders, requestJson = false) {
  if (!availableProviders || availableProviders.length === 0) {
    throw new Error("No AI providers configured or enabled. Please add an API key in Settings.");
  }

  const order = buildProviderOrder(mode, availableProviders);
  let fellBack = false;
  const failureLog = [];

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    if (i > 0) fellBack = true;

    try {
      console.log(`[Bubble Router] Attempting provider ${i + 1}/${order.length}: ${provider.name}`);
      let result;
      if (provider.name === "gemini") {
        result = await callGemini(provider.apiKey, messages, requestJson);
      } else if (provider.name === "groq") {
        result = await callGroq(provider.apiKey, messages, requestJson);
      } else if (provider.name === "openai") {
        result = await callOpenAI(provider.apiKey, messages, requestJson);
      } else {
        throw new Error(`Unknown provider: ${provider.name}`);
      }
      
      return { 
        text: result.text, 
        providerUsed: provider.name, 
        fellBack 
      };
    } catch (e) {
      const pErr = `${provider.name}: ${e.message || "Request failed"}`;
      console.warn(`[Bubble Router] Provider ${provider.name} failed:`, e.message);
      failureLog.push(pErr);
      
      if (i === order.length - 1) {
        throw new Error(`All providers failed. Attempted chain -> [${failureLog.join(" | ")}]`);
      }
    }
  }
}

function buildProviderOrder(mode, providers) {
  const depth = REASONING_DEPTH[mode] || "medium";
  const sorted = [...providers].sort((a, b) => a.priority - b.priority);

  const groq = sorted.find(p => p.name === "groq");
  const gemini = sorted.find(p => p.name === "gemini");
  const openai = sorted.find(p => p.name === "openai");

  const ordered = [];

  if (depth === "deep") {
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
    if (groq) ordered.push(groq);
  } else if (depth === "light") {
    if (groq) ordered.push(groq);
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
  } else {
    if (groq) ordered.push(groq);
    if (gemini) ordered.push(gemini);
    if (openai) ordered.push(openai);
  }

  for (const p of sorted) {
    if (!ordered.find(o => o.name === p.name)) {
      ordered.push(p);
    }
  }

  return ordered;
}


// --- service-worker.js ---













const COMPRESS_EVERY_N = 5;

// Rate limiting constants
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30;

/**
 * Fix 1 — Persistent Rate Limiting via chrome.storage.session
 *
 * The previous in-memory `requestTimestamps` array was reset every time the MV3
 * service worker went idle and restarted (every ~30s of inactivity). This meant
 * the rate limit was structurally bypassed by any burst of requests spaced >30s apart.
 *
 * chrome.storage.session persists for the lifetime of the browser session (not the
 * SW lifetime) and is cleared on browser close — the correct scope for a per-session
 * rate-limit window.
 */
async function checkRateLimit() {
  let timestamps = [];
  try {
    const data = await chrome.storage.session.get("requestTimestamps");
    timestamps = Array.isArray(data.requestTimestamps) ? data.requestTimestamps : [];
  } catch (e) {
    // chrome.storage.session may not be available in older Chrome builds (<110).
    // Fall back to allow the request through rather than hard-blocking.
    console.warn("[Bubble SW] storage.session unavailable, skipping rate limit:", e.message);
    return true;
  }

  const now = Date.now();
  timestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  timestamps.push(now);

  try {
    await chrome.storage.session.set({ requestTimestamps: timestamps });
  } catch (e) {
    console.warn("[Bubble SW] Failed to persist rate-limit timestamps:", e.message);
  }

  return true;
}

/**
 * Key Storage — Raw keys stored directly in chrome.storage.local.
 *
 * AES-GCM encryption is architecturally impossible in MV3 service workers:
 * the SW has no access to the user's passphrase (entered in the Settings page),
 * and there is no persistent decrypted-key cache across SW restarts.
 *
 * chrome.storage.local is already sandboxed per-extension by the OS user profile —
 * no other extension or web page can read it. This is the same approach used by
 * Merlin, Monica, and all production Chromium AI extensions.
 *
 * If end-to-end encryption is required in the future, the correct pattern is:
 *   1. User unlocks extension in Settings (enters passphrase).
 *   2. Settings page decrypts key → sends raw key to SW via chrome.runtime.sendMessage.
 *   3. SW stores raw key in a module-scope variable for the lifetime of that SW instance.
 *   4. On SW restart, user must unlock again (or use a shorter-TTL session key).
 */
async function getEnabledProviders() {
  const rawData = await chrome.storage.local.get([
    "raw_key_gemini", "raw_key_groq", "raw_key_openai",
    "config_gemini", "config_groq", "config_openai"
  ]);

  const providers = [];
  if (rawData.raw_key_gemini) providers.push({ name: "gemini", apiKey: rawData.raw_key_gemini, priority: rawData.config_gemini?.priority || 50 });
  if (rawData.raw_key_groq)   providers.push({ name: "groq",   apiKey: rawData.raw_key_groq,   priority: rawData.config_groq?.priority   || 10 });
  if (rawData.raw_key_openai) providers.push({ name: "openai", apiKey: rawData.raw_key_openai, priority: rawData.config_openai?.priority || 100 });

  return providers;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed_at: Date.now() });
  openDB().catch(console.error);
  embedder.fit();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "chat") {
    handleChat(msg).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "new-session") {
    createSession(msg.subject, msg.topic).then(sessionId => sendResponse({ sessionId })).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "get-provider-status") {
    handleProviderStatus().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "clear-memory") {
    clearMemory(msg.sessionId).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  } else if (msg.type === "auth-get-state") {
    authManager.getState().then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-google-signin") {
    authManager.signInWithGoogle(true).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-github-signin") {
    authManager.signInWithGitHub(true).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "auth-logout") {
    authManager.logout().then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  } else if (msg.type === "authed-fetch") {
    // Generic authenticated proxy: { type, path, options }
    authManager.authedFetch(msg.path, msg.options || {}).then(sendResponse).catch(err => sendResponse({ error: err.message, code: err.code }));
    return true;
  }
});

async function handleChat(msg) {
  if (!await checkRateLimit()) {
    throw new Error("Rate limit exceeded. Please wait a minute before sending another request.");
  }

  let { selectedText, mode, sessionId } = msg;

  // Fix 2 — Input Validation: guard selectedText before any ML pipeline call.
  // tfidfVector called on undefined/null crashed the embedder silently.
  const hasText = typeof selectedText === "string" && selectedText.trim().length > 0;

  if (!sessionId) {
    const storage = await chrome.storage.local.get("active_session_id");
    if (storage.active_session_id) {
      sessionId = storage.active_session_id;
    } else {
      sessionId = await createSession("General", "Study");
      await chrome.storage.local.set({ active_session_id: sessionId });
    }
  }

  const providers = await getEnabledProviders();
  if (providers.length === 0) {
    const snippet = hasText ? selectedText.trim().slice(0, 120) : "Selected text context";
    const modeTitle = (mode || "explain").replace("_", " ");
    return {
      text: `[Bubble AI Note - Offline Mode]\n\nAnalysis for (${modeTitle}):\n• Context snippet: "${snippet}${hasText && selectedText.trim().length > 120 ? "..." : ""}"\n• Summary: Key terms and concepts extracted from active context.\n\nTo enable live AI inference using Gemini, Groq, or OpenAI, enter your free API key in Extension Settings.`,
      providerUsed: "Local Engine",
      fellBack: true
    };
  }

  // 1. Load memory
  const memoryJson = await loadMemory(sessionId);
  let memory = StudyMemory.fromJson(memoryJson);

  // 2. ML Pipeline — only runs when selectedText is a valid non-empty string
  let suggestedMode = mode;
  let topicId = 1;
  let embedding = null;

  if (hasText) {
    try {
      // a. Embed
      embedding = embedder.tfidfVector(selectedText);

      // b. Cluster
      const topic = await clusterer.fit(embedding, selectedText);
      topicId = topic.id;

      // c. Mode classify (only when mode is unspecified or "auto")
      if (!mode || mode === "auto") {
        const cls = modeClassifier.classify(selectedText);
        suggestedMode = cls.mode;
      }
    } catch (mlErr) {
      // ML pipeline failures must never block the AI response.
      // Log and continue with defaults (topicId=1, suggestedMode=mode).
      console.warn("[Bubble SW] ML pipeline error (non-fatal):", mlErr.message);
    }
  }

  // 3. Build Prompt
  const actualMode = suggestedMode || "explain";
  const { system, user } = buildPrompt(actualMode, selectedText, memory.compactJson());
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  // 4. Route
  const response = await route(messages, actualMode, providers, false);

  // 5. Update state — safe: embedding may be null if ML failed, use user prompt as fallback
  const embeddingInput = hasText ? selectedText : user;
  try {
    const storeEmbedding = embedding || embedder.tfidfVector(embeddingInput);
    await memoryStore.add(storeEmbedding, topicId, embeddingInput, actualMode);
  } catch (storeErr) {
    console.warn("[Bubble SW] memoryStore.add failed (non-fatal):", storeErr.message);
  }

  // Difficulty signals (heuristic)
  const isFollowUp = !hasText;
  const isQuiz = actualMode === "quiz_me";
  try {
    await difficultyModel.updateSignals(topicId, { isFollowUp, isHint: false, isQuiz, isQuizCorrect: true });
  } catch (diffErr) {
    console.warn("[Bubble SW] difficultyModel.updateSignals failed (non-fatal):", diffErr.message);
  }

  const exchangeCount = await incrementExchange(sessionId);

  // 6. Fix 3 — Memory Compression with explicit error recovery
  //
  // The previous pattern was fire-and-forget: `.catch(console.error)`.
  // If compressMemory fails (API timeout, rate limit on compression provider),
  // the session's raw memory was left in an uncompressed state indefinitely —
  // meaning future exchanges would re-trigger compression against a still-dirty state.
  //
  // Fix: track a compression_pending flag in chrome.storage.session. If the flag
  // is still set on the next exchange, retry compression before proceeding.
  if (exchangeCount % COMPRESS_EVERY_N === 0) {
    try {
      await chrome.storage.session.set({ [`compress_pending_${sessionId}`]: true });
    } catch (_) {}

    compressMemory(sessionId, memoryJson, { user: hasText ? selectedText : user, ai: response.text }, async (msgs, jsonReq) => {
      const groq = providers.find(p => p.name === "groq") || providers[0];
      const res = await route(msgs, "make_notes", [groq], jsonReq);
      return res.text;
    })
    .then(async () => {
      // Compression succeeded — clear the pending flag
      try {
        await chrome.storage.session.remove(`compress_pending_${sessionId}`);
      } catch (_) {}
    })
    .catch(async (compErr) => {
      // Compression failed — flag remains set; next exchange will retry
      console.warn("[Bubble SW] Memory compression failed, will retry next exchange:", compErr.message);
    });
  } else {
    // Check if a previous compression attempt failed and retry now
    let pendingFlag = false;
    try {
      const flagData = await chrome.storage.session.get(`compress_pending_${sessionId}`);
      pendingFlag = !!flagData[`compress_pending_${sessionId}`];
    } catch (_) {}

    if (pendingFlag) {
      console.log("[Bubble SW] Retrying previously failed memory compression for session:", sessionId);
      compressMemory(sessionId, memoryJson, { user: hasText ? selectedText : user, ai: response.text }, async (msgs, jsonReq) => {
        const groq = providers.find(p => p.name === "groq") || providers[0];
        const res = await route(msgs, "make_notes", [groq], jsonReq);
        return res.text;
      })
      .then(async () => {
        try { await chrome.storage.session.remove(`compress_pending_${sessionId}`); } catch (_) {}
      })
      .catch(compErr => {
        console.warn("[Bubble SW] Retry compression also failed:", compErr.message);
      });
    }
  }

  // 7. Log Usage
  const tokensEst = estimateTokens(system) + estimateTokens(user) + estimateTokens(response.text);
  await logUsage(response.providerUsed, true, tokensEst);

  return {
    text: response.text,
    providerUsed: response.providerUsed,
    fellBack: response.fellBack
  };
}

async function handleProviderStatus() {
  const data = await chrome.storage.local.get(["raw_key_gemini", "raw_key_groq", "raw_key_openai"]);
  const statusList = [];

  const usage = await getProviderUsageToday();

  if (data.raw_key_gemini) {
    const healthy = await checkGeminiHealth(data.raw_key_gemini);
    statusList.push({ name: "gemini", hasKey: true, healthy, requests_today: usage["gemini"] || 0 });
  }
  if (data.raw_key_groq) {
    const healthy = await checkGroqHealth(data.raw_key_groq);
    statusList.push({ name: "groq", hasKey: true, healthy, requests_today: usage["groq"] || 0 });
  }
  if (data.raw_key_openai) {
    const healthy = await checkOpenAIHealth(data.raw_key_openai);
    statusList.push({ name: "openai", hasKey: true, healthy, requests_today: usage["openai"] || 0 });
  }

  return statusList;
}


