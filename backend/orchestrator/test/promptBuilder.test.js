const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, approxTokenCount, MAX_CONTEXT_TOKENS, MAX_MEMORY_TURNS } = require("../lib/promptBuilder");

function words(n) {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

test("includes system prompt and user query with no context/history", () => {
  const { messages } = buildPrompt([], [], "hello there");
  assert.equal(messages[0].role, "system");
  assert.equal(messages.at(-1).content, "hello there");
});

test("context never exceeds the 1000-token budget", () => {
  const bigChunks = [words(400), words(400), words(400), words(400)];
  const { contextTokens } = buildPrompt(bigChunks, [], "q");
  assert.ok(contextTokens <= MAX_CONTEXT_TOKENS, `contextTokens=${contextTokens}`);
});

test("keeps most relevant (first) chunks when trimming to budget", () => {
  const chunks = [words(300), words(300), words(300), words(300)];
  const { messages } = buildPrompt(chunks, [], "q");
  const contextMsg = messages.find((m) => m.content.startsWith("Context:"));
  assert.ok(contextMsg.content.includes("[1]"));
  // 4th chunk (300*4=1200 approx tokens > 1000) should have been dropped
  assert.ok(!contextMsg.content.includes("[4]"));
});

test("truncates a single oversized chunk instead of sending nothing", () => {
  const oneHugeChunk = [words(2000)];
  const { contextTokens, messages } = buildPrompt(oneHugeChunk, [], "q");
  assert.ok(contextTokens <= MAX_CONTEXT_TOKENS);
  assert.ok(messages.some((m) => m.content.startsWith("Context:")));
});

test("memory window caps at MAX_MEMORY_TURNS, never full replay", () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: "user", content: `turn ${i} question` });
    history.push({ role: "assistant", content: `turn ${i} answer` });
  }
  const { messages, memoryTurnsUsed } = buildPrompt([], history, "current question");
  assert.ok(memoryTurnsUsed <= MAX_MEMORY_TURNS);

  const historyContentInPrompt = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => m.content);
  // Should NOT contain the earliest turns (full replay would include "turn 0")
  assert.ok(!historyContentInPrompt.some((c) => c.includes("turn 0 question")));
  // Should contain the most recent turn
  assert.ok(historyContentInPrompt.some((c) => c.includes("turn 9")));
});

test("approxTokenCount scales with word count", () => {
  assert.ok(approxTokenCount(words(100)) > approxTokenCount(words(10)));
  assert.equal(approxTokenCount(""), 0);
});

test("empty retrievedChunks array produces no Context message", () => {
  const { messages } = buildPrompt([], [], "q");
  assert.ok(!messages.some((m) => m.content.startsWith("Context:")));
});
