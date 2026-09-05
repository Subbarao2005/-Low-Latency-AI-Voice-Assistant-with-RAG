/**
 * Redis cache key generation.
 *
 * Goal: two queries that are semantically identical but differ in casing / punctuation /
 * whitespace should hit the same cache entry ("cache frequent queries" requirement).
 * We do NOT do semantic/embedding-based cache matching here -- that would cost a Qdrant
 * round trip just to decide on a cache hit, defeating the purpose. Normalization is cheap
 * (sub-millisecond) and catches the common case of repeated/near-identical questions.
 */

function normalizeQuery(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ");   // collapse whitespace
}

/**
 * @param {string} query - raw user query text
 * @param {string} kbVersion - identifier for the current knowledge base version/collection
 *                             (e.g. a Qdrant collection name + last-ingest timestamp).
 *                             Included so a KB re-ingest invalidates stale cached answers
 *                             without needing an explicit flush.
 * @returns {string} cache key
 */
function buildCacheKey(query, kbVersion = "default") {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("buildCacheKey requires a non-empty query string");
  }
  const normalized = normalizeQuery(query);
  return `qa:${kbVersion}:${normalized}`;
}

module.exports = { buildCacheKey, normalizeQuery };
