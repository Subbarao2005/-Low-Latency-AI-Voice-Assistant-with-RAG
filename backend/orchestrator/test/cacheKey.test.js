const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCacheKey, normalizeQuery } = require("../lib/cacheKey");

test("normalizes case, punctuation, and whitespace", () => {
  const a = buildCacheKey("What is your Refund Policy?");
  const b = buildCacheKey("what is your refund policy");
  const c = buildCacheKey("  WHAT   is your refund   policy!!");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("different queries produce different keys", () => {
  const a = buildCacheKey("what is your refund policy");
  const b = buildCacheKey("what is your shipping policy");
  assert.notEqual(a, b);
});

test("kb version is part of the key so re-ingest invalidates cache", () => {
  const a = buildCacheKey("hello", "kb-v1");
  const b = buildCacheKey("hello", "kb-v2");
  assert.notEqual(a, b);
});

test("throws on empty query", () => {
  assert.throws(() => buildCacheKey(""));
  assert.throws(() => buildCacheKey("   "));
});

test("normalizeQuery strips punctuation but keeps words", () => {
  assert.equal(normalizeQuery("Hi, there!!"), "hi there");
});
