import { embedder } from "./tfidf.js";
import { saveTopics, loadTopics } from "../db/indexeddb.js";

const DEFAULT_THRESHOLD = 0.42;

export class OnlineTopicClusterer {
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

export const clusterer = new OnlineTopicClusterer();
