# QA Test Plan — Voice Assistant (RAG)

Every test below is traced back to a line in the original problem statement so you can see
exactly what's being verified and why.

## 1. Unit-level (run in CI, no external services needed)

| # | Test file | What it verifies | Spec line |
|---|---|---|---|
| 1.1 | `backend/ingest/test_chunk.py` | Chunks stay within 300–500 tokens; no gaps/dropped text; overlap exists for continuity | "chunk size: 300-500 tokens" |
| 1.2 | `backend/orchestrator/test/promptBuilder.test.js` | Context never exceeds 1000 tokens; least-relevant chunks dropped first, not truncating the whole context to zero; memory window caps at 3 turns, no full replay | "context limit: ≤1000 tokens", "short-term: last 2-3 turns", "avoid full conversation replay" |
| 1.3 | `backend/orchestrator/test/cacheKey.test.js` | Semantically-identical queries (case/punctuation/whitespace) hash to the same key; KB version busts stale cache | "cache frequent queries and responses in Redis" |

Run: `cd backend/ingest && python -m pytest -v` and `cd backend/orchestrator && npm test`

## 2. Workflow structural validation

| # | Test | Method |
|---|---|---|
| 2.1 | `workflow.json` is valid JSON | `python -m json.tool workflow.json > /dev/null` |
| 2.2 | Every connection references a real node (no orphaned/typo'd node names) | script in this repo's build log; re-run: parse `nodes[].name` set, diff against `connections` keys/targets |
| 2.3 | No node ID collisions | dedupe check on `nodes[].id` |

## 3. Integration tests (require docker-compose stack + real API keys)

| # | Test | Steps | Pass criteria |
|---|---|---|---|
| 3.1 | Ingestion round-trip | `python ingest.py --source ./sample_docs --collection kb_test --recreate`, then query Qdrant directly for a known phrase | Correct chunk returned in top-3 with score > 0.3 |
| 3.2 | Cache hit path | Send the same query twice via the webhook | 2nd request's Redis GET returns non-empty; TTS audio returned without a new OpenAI call (check n8n execution log for skipped "OpenAI: streaming completion" node) |
| 3.3 | Cache miss → full pipeline | Send a novel query | All 15 workflow nodes execute in order; final audio arrives at the relay callback |
| 3.4 | Barge-in | Start playback, then speak into the mic again before it finishes | `stopPlayback()` fires client-side; old turn's `tts_chunk` messages are dropped (relay's `activeTurns` map no longer points a stale turn at an open turn) |
| 3.5 | CRM/backend action hook | Enable `crmAction` node, send a query that should trigger lead capture | POST received at `CRM_WEBHOOK_URL` with transcript + timestamp |
| 3.6 | Region check | Confirm n8n, Qdrant, Redis, and your OpenAI/Sarvam account region all match | `docker-compose.yml` deployed to single region; no cross-region hop >50ms in traceroute |

## 4. Latency tests (require live stack — `benchmarks/latency_test.py`)

| # | Metric | Target | Command |
|---|---|---|---|
| 4.1 | First audio byte | ≤1.5s (target), ≤2.0s (hard max) | `python benchmarks/latency_test.py --runs 20` |
| 4.2 | RAG retrieval | ≤150ms | Check n8n execution timing on the "Qdrant: retrieve top_k=3" node (n8n UI → execution → node duration) |
| 4.3 | LLM first token | ≤800ms | Reported by `latency_test.py` as `first_llm_token_ms` |
| 4.4 | Inter-chunk audio gap | never >500ms | Reported by `latency_test.py` as `max_inter_chunk_gap_ms` |
| 4.5 | Concurrent load | stable under concurrent usage | Run `latency_test.py` from 5-10 parallel processes simultaneously; p95 first-audio should not regress more than ~30% vs. single-stream baseline |

## 5. Failure-condition tests (spec's explicit "Failure Conditions")

| # | Scenario | Expected behavior |
|---|---|---|
| 5.1 | Response delay > 3s | Should never happen given 4.1's hard max of 2.0s; if it does, treat as a P0 regression |
| 5.2 | Blocking workflow | Verify the webhook responds "accepted" immediately (node `webhookResponse`) rather than holding the HTTP connection open until TTS finishes |
| 5.3 | Excessive context slows LLM | Feed a query that matches many KB chunks; confirm context is still capped at 1000 tokens (test 1.2 covers this at the unit level; re-verify against real retrieval count) |
| 5.4 | Non-streaming audio output | Confirm `tts_chunk` messages arrive incrementally (multiple `seq` values over time), not as one giant final blob |

## 6. Manual UX / success-criteria checklist

- [ ] User hears response within 1–2 seconds in normal network conditions
- [ ] No noticeable lag or silence gaps during playback
- [ ] Answers are accurate and grounded in the ingested KB (spot-check 10 questions against source docs)
- [ ] Barge-in works: speaking over the assistant stops its audio immediately
- [ ] Mic permission / HTTPS requirement is handled gracefully (clear error if not on localhost/HTTPS)
- [ ] Settings persist across page reload (localStorage)
