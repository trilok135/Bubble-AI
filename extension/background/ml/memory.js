import { saveInteraction, getInteractionsByTopic, saveMemory, loadMemory } from "../db/indexeddb.js";
import { embedder, cosineSimilarity } from "./tfidf.js"; // BUG-10: import standalone fn

const MAX_MEMORY_TOKENS = 300;

export class StudyMemory {
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

export function estimateTokens(text) {
  if (!text) return 0;
  // Heuristic: words + punctuation
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;
  // A rough approximation
  return Math.max(words, Math.ceil(chars / 4));
}

// MemoryStore for Topic-scoped cosine retrieval
export class MemoryStore {
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

export const memoryStore = new MemoryStore();

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

export async function compressMemory(sessionId, oldMemoryJson, newExchange, callLLM) {
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
