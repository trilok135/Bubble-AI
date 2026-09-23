const DB_NAME = "bubble-ai-db";
const DB_VERSION = 1;

let dbPromise = null;

export async function openDB() {
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

export function now() {
  return new Date().toISOString();
}

// ---------- sessions ----------
export async function createSession(subject = null, topic = null) {
  return transaction("sessions", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ subject, topic, createdAt: now(), exchangeCount: 0 });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

export async function getSession(sessionId) {
  return transaction("sessions", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.get(sessionId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

export async function incrementExchange(sessionId) {
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
export async function loadMemory(sessionId) {
  return transaction("study_memory", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.get(sessionId);
      req.onsuccess = () => res(req.result ? req.result.jsonBlob : null);
      req.onerror = () => rej(req.error);
    });
  });
}

export async function saveMemory(sessionId, memoryJson) {
  return transaction("study_memory", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.put({ sessionId, jsonBlob: memoryJson, updatedAt: now() });
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  });
}

export async function clearMemory(sessionId) {
    return transaction("study_memory", "readwrite", async (store) => {
        return new Promise((res, rej) => {
            const req = store.delete(sessionId);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
        });
    });
}

// ---------- usage ----------
export async function logUsage(provider, success, tokensEst) {
  return transaction("usage_log", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ provider, ts: now(), success: success ? 1 : 0, tokensEst });
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  });
}

export async function requestsToday(provider) {
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

export async function getProviderUsageToday() {
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
export async function saveInteraction(embedding, topicId, mode) {
  return transaction("interactions", "readwrite", async (store) => {
    return new Promise((res, rej) => {
      const req = store.add({ embedding, topicId, mode, createdAt: now() });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

export async function getInteractionsByTopic(topicId) {
  return transaction("interactions", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const index = store.index("topicId");
      const req = index.getAll(topicId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

export async function saveTopics(topics) {
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

export async function loadTopics() {
  return transaction("topics", "readonly", async (store) => {
    return new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
}

// ---------- user profile ----------
export async function loadUserProfile(userId = "default") {
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

export async function saveUserProfile(profile) {
    return transaction("user_profile", "readwrite", async (store) => {
        return new Promise((res, rej) => {
            const req = store.put(profile);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
        });
    });
}
