/**
 * Builds the LLM prompt from retrieved RAG chunks + short-term conversation memory.
 *
 * Spec constraints enforced here:
 *   - context limit: <= 1000 tokens of retrieved chunk text
 *   - short-term memory: last 2-3 turns only, never full conversation replay
 *   - minimize prompt size / system instructions
 */

const MAX_CONTEXT_TOKENS = 1000;
const MAX_MEMORY_TURNS = 3;

// Cheap approximation consistent with the ingestion side (chunk.py's fallback counter).
function approxTokenCount(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * 1.3);
}

const SYSTEM_PROMPT =
  "You are a concise voice assistant. Answer using only the provided context. " +
  "If the context doesn't contain the answer, say you don't know. Keep replies short " +
  "and speakable aloud.";

/**
 * @param {string[]} retrievedChunks - ranked, most-relevant-first chunk texts from Qdrant
 * @param {{role: 'user'|'assistant', content: string}[]} history - full conversation history
 * @param {string} userQuery - the current user turn
 * @returns {{messages: object[], contextTokens: number, memoryTurnsUsed: number}}
 */
function buildPrompt(retrievedChunks, history, userQuery) {
  // 1. Trim retrieved context to the token budget, dropping least-relevant chunks first.
  let contextTokens = 0;
  const keptChunks = [];
  for (const chunk of retrievedChunks || []) {
    const t = approxTokenCount(chunk);
    if (contextTokens + t > MAX_CONTEXT_TOKENS) {
      if (keptChunks.length === 0) {
        // Even the single most relevant chunk is too big: truncate it rather than send nothing.
        const words = chunk.trim().split(/\s+/);
        const budget = Math.floor(MAX_CONTEXT_TOKENS / 1.3);
        const truncated = words.slice(0, budget).join(" ");
        keptChunks.push(truncated);
        contextTokens += approxTokenCount(truncated);
      }
      break;
    }
    keptChunks.push(chunk);
    contextTokens += t;
  }

  // 2. Keep only the last N turns of memory -- never full replay.
  const recentHistory = (history || []).slice(-MAX_MEMORY_TURNS * 2); // user+assistant pairs

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (keptChunks.length > 0) {
    messages.push({
      role: "system",
      content: `Context:\n${keptChunks.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`,
    });
  }
  for (const turn of recentHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: userQuery });

  return {
    messages,
    contextTokens,
    memoryTurnsUsed: Math.floor(recentHistory.length / 2),
  };
}

module.exports = { buildPrompt, approxTokenCount, MAX_CONTEXT_TOKENS, MAX_MEMORY_TURNS };
