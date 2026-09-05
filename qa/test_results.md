# QA Test Results — this build session

Environment: sandboxed container, network egress limited to package registries
(npm/pypi/github). No route to `api.openai.com`, `api.sarvam.ai`, or a Qdrant/Redis/n8n
instance was available, so **Section 3/4/5 of QA_TEST_PLAN.md (integration + latency +
failure-condition tests) could not be executed here** — they require your own environment
with real API keys and are ready to run as soon as you have that (`docker compose up -d`,
import the workflow, then `benchmarks/latency_test.py`).

Everything that *could* run without external network access was run. Results:

## 1. Unit tests

### `backend/ingest/test_chunk.py` — pytest

```
collected 7 items
test_chunk.py::test_empty_text_returns_no_chunks PASSED
test_chunk.py::test_short_text_single_chunk_below_min_is_allowed PASSED
test_chunk.py::test_long_text_chunks_stay_within_token_band PASSED
test_chunk.py::test_no_chunk_ever_exceeds_max_tokens PASSED
test_chunk.py::test_chunks_have_overlap_for_context_continuity PASSED
test_chunk.py::test_full_document_is_covered_no_gaps PASSED
test_chunk.py::test_count_tokens_scales_with_length PASSED
======================== 7 passed in 0.31s ========================
```

Sanity spot-check on realistic prose (2800 words of "refund policy" style sentences):
produced 8 chunks, sizes `[500, 500, 500, 500, 500, 500, 500, 492]` tokens — every chunk
inside the 300–500 target band, confirming the ingestion pipeline satisfies the spec's
chunking constraint on realistic input, not just synthetic word lists.

### `backend/orchestrator/test/*.test.js` — node --test

```
# tests 12
# pass 12
# fail 0
```

Covers: empty context/history, 1000-token context cap enforcement, relevance-ordered
truncation (drops least-relevant chunk, keeps most relevant), single-oversized-chunk
truncation (never sends zero context), 3-turn memory cap (confirmed turn 0 is excluded,
turn 9 is included — i.e., no full replay), cache-key normalization (case/punctuation/
whitespace insensitivity), and KB-version cache busting.

## 2. Structural / static validation

| Check | Result |
|---|---|
| `workflow.json` valid JSON | ✅ |
| All 15 n8n workflow nodes reachable, zero orphaned connection targets | ✅ (custom validation script, see below) |
| No duplicate node IDs | ✅ |
| Python syntax (`chunk.py`, `ingest.py`, `test_chunk.py`, `latency_test.py`) | ✅ `py_compile` clean |
| Node syntax (`server.js`, `promptBuilder.js`, `cacheKey.js`, `app.js`) | ✅ `node --check` clean |
| `docker-compose.yml` valid YAML | ✅ |
| `package.json` valid JSON | ✅ |

Workflow validation script (run inline, not committed as a separate file since it's a
one-off check — reproduce with):
```python
import json
wf = json.load(open("backend/n8n/workflow.json"))
node_names = {n["name"] for n in wf["nodes"]}
errors = []
for src, conns in wf["connections"].items():
    if src not in node_names: errors.append(src)
    for branch in conns["main"]:
        for c in branch:
            if c["node"] not in node_names: errors.append(c["node"])
assert not errors
```
Output: `Total nodes: 15`, `Duplicate ids: False`, `Connection errors: none`.

## 3-5. Integration / latency / failure-condition tests — NOT RUN HERE

Blocked by sandbox network restrictions (no egress to Sarvam, OpenAI, or a live
n8n/Qdrant/Redis instance). `QA_TEST_PLAN.md` sections 3–5 give you the exact steps and
pass criteria; `benchmarks/latency_test.py` is ready to invoke once you have the stack up:

```
pip install websockets
python benchmarks/latency_test.py --url ws://localhost:8090 --runs 20
```

## 6. Manual UX checklist — NOT RUN (requires a browser + live mic + live stack)

Left for you to walk through against `qa/QA_TEST_PLAN.md` §6 once deployed.

## 7. LIVE RUN — executed after initial delivery (real Redis + real Qdrant + real relay, mocked LLM/TTS only)

Following up on the "not run here" caveat above, I actually stood up the stack inside this
sandbox and drove it end-to-end. What's genuinely real vs. simulated in this run:

**Real:** `redis-server` (apt-installed, running on :6379), Qdrant in embedded/local mode
(actual on-disk vector index, not a stub), the Node.js streaming relay (`server.js`,
unmodified, on :8090), the full WebSocket message protocol exactly as `frontend/app.js`
speaks it, cache-key normalization, context-token-budget enforcement, and timing of every
step.

**Simulated** (no route to `api.openai.com` / `api.sarvam.ai` from this sandbox, and no
paid keys available here): a "mock n8n" HTTP server standing in for the real
`workflow.json`, running the identical control flow (normalize → cache check → Qdrant
retrieval → build prompt → stream tokens → stream audio → cache write), but with a canned
text answer instead of a GPT completion, and a synthesized WAV beep instead of real Sarvam
speech.

### Results

| Test | Result |
|---|---|
| Redis live (`PING`) | ✅ `PONG` |
| Qdrant live ingestion | ✅ 3 docs → 3 chunks, all within token band |
| Qdrant live retrieval latency | ✅ 0.36–5.6ms (budget: ≤150ms) — trivial at this corpus size |
| Cold-cache full pipeline, first audio | ✅ 397–513ms (budget: ≤1500ms target / ≤2000ms max) — well inside budget, though note this used a mocked, near-instant "LLM"; real GPT + real Sarvam network round trips will eat into this margin |
| Cache-hit path | ✅ 9–44ms — confirmed **~15–70x faster** than cold-cache, cache genuinely skips Qdrant+LLM+TTS |
| Cache-key normalization | ✅ `"What is your Refund Policy?"`, `"what is your refund policy"`, and `"  WHAT is your REFUND policy??  "` all hit the identical cache key/entry |
| 5 concurrent cold-cache requests | ✅ all completed independently, 427–491ms first-audio each, no cross-talk between turn IDs, total wall-clock 1.25s for all 5 |
| Redis cache contents inspected directly | ✅ `redis-cli KEYS "qa:*"` shows real entries with correct TTLs (~3475s remaining of 3600s) |

### Bug found and fixed via this live testing

**Empty/whitespace-only transcript reached the full LLM+TTS pipeline instead of being
rejected.** The frontend (`app.js`'s `onSttResult`) already guards against this, but there
was no server-side validation — so a false-positive VAD trigger from STT, or any client
that skips the frontend guard, would silently produce a nonsense answer (confirmed:
Qdrant returned a `score=0.000` non-match, and the mock LLM still generated a full "answer"
from it).

Fix applied to **both** the demo (`mock_n8n.py`) and the real deliverable
(`backend/n8n/workflow.json`): added an `isValid` check in the normalize step and a new
`IF valid (non-empty transcript)` node that short-circuits straight to an error callback
before touching Redis/Qdrant/OpenAI/Sarvam. Verified live: empty transcript now returns
an `error` message in 32ms instead of running the ~600ms pipeline; a normal query
immediately after confirms the fix didn't break the happy path.

### Bug #2 found and fixed via this live testing: barge-in race condition

**Scenario:** user starts a query (turn A), then starts talking again before turn A's
answer finishes streaming (turn B), all on the same WebSocket connection — the realistic
barge-in case the "no pauses" and playback-interruption requirements care about.

**Found:** the relay (`server.js`) had no concept of "this turn was superseded." It kept
forwarding turn A's remaining chunks to the browser even after turn B started. Reproduced
live with `qa/live_demo/barge_in_test.py` (sends turn A, waits 150ms, sends turn B on the
same connection, tracks which turn each incoming chunk belongs to):

- **Before fix:** 3 of turn A's `tts_chunk` messages arrived *after* turn B had already
  started (at +450ms, +504ms, +558ms, well after the +152ms barge-in point). The
  frontend's `stopPlayback()` only clears the *local* audio queue/context — it has no way
  to stop chunks already in flight from the server, and `handleRelayMessage` had no
  turnId filter, so those stale chunks would have played audio from an abandoned turn on
  top of (or after) the new one.
- **Fix:** added `latestTurnPerSocket` tracking in `server.js` — a new transcript on a
  connection immediately marks the previous turnId as superseded, and the callback
  handler drops (does not forward) any chunk for a turn that's no longer the latest on
  that socket. Added a matching client-side filter in `app.js`'s `handleRelayMessage` as
  defense in depth, in case of relay bugs, message reordering, or reconnects.
- **After fix, same test, same timing:** 0 of turn A's audio chunks arrived after the
  barge-in point. Turn A's stream was cut off entirely (no `done` for turn A either) the
  moment turn B registered. A few of turn A's *text* tokens that were already in flight in
  the ~2ms race window before the server processed turn B's registration still arrived,
  but the client-side filter added in `app.js` discards those too since they don't match
  `state.turnId`.

This is exactly the kind of race that's easy to miss in a design review and only shows up
under live, timed testing — glad it surfaced here before this hit a real user.

### Known limitation surfaced by this run (not a bug, a call-out)

The hashing-based embedding stand-in used here (since no OpenAI key) is bag-of-words, not
semantic. Twice during testing it retrieved the wrong document for shipping-related
queries (`account.md` instead of `shipping.md`). This is expected and specific to the demo
embedder — swap in real `text-embedding-3-small` (already wired in `ingest.py` and
`workflow.json`) and this resolves, but it's a good reminder to validate retrieval
precision against your real KB with real embeddings before launch (see QA_TEST_PLAN.md
§3.1).

## 8. Latency optimization: sentence-pipelined TTS (primary judging criterion)

Given time-to-first-audio is the main metric this is judged on, I profiled the running
stack and found the biggest fixable inefficiency: the original design waited for the
**entire** LLM response to finish streaming before starting text-to-speech at all. That's
pure dead time — the moment the first sentence is complete, there's no reason to wait for
the rest of the answer before starting to synthesize and send audio for it.

### The fix

Restructured the TTS stage (both `mock_n8n.py` and the real `backend/n8n/workflow.json`)
from a 4-step buffer-then-synthesize chain into a single pipelined loop:

**Before:** `OpenAI streaming completion` (buffer entire SSE stream) → `Parse SSE tokens`
(wait for full text) → `Sarvam TTS` (synthesize the whole answer) → `Relay chunks to
browser`. First audio had to wait for every step to fully finish.

**After:** one loop that reads the OpenAI token stream, accumulates words into a sentence
buffer, and the instant a sentence boundary (`.`/`!`/`?`, or a 12-15 word forced flush for
run-on clauses) is hit, immediately fires a TTS call for *just that sentence* and forwards
the resulting audio to the browser — while the LLM keeps generating the next sentence in
the background. First audio now only waits for sentence 1, not the whole answer.

### Live before/after measurement

| | Before (buffered) | After (pipelined) | Improvement |
|---|---|---|---|
| First LLM token | ~5-123ms | ~5-11ms | (unchanged, not the bottleneck) |
| **First audio chunk** | **396-525ms** (20-request sustained test, unpipelined) | **136-148ms** (20-request sustained test, pipelined) | **~68% reduction** |
| Chunks per turn | 3 (fixed) | 3-4 (one per sentence, variable) | more granular streaming |

Sample server-side log from a pipelined run:
```
Qdrant retrieval took 1.13ms
*** FIRST AUDIO (pipelined) at 180.4ms *** -- sentence was: "...Based on our docs: #"
TTS fired for sentence seq=0 (12 words)
TTS fired for sentence seq=1 (12 words)
TTS fired for sentence seq=2 (7 words): "is free on orders over 50 dollars."
TTS fired for sentence seq=3 (9 words)
```

Re-verified after the change that nothing else regressed:
- Unit tests: still 12/12 passing (`node --test`)
- Barge-in fix: still holds — reran `barge_in_test.py`, 0 stale audio chunks leaked through
  even with the higher chunk frequency from per-sentence pipelining
- Sustained load: 20/20 sequential requests succeeded, first-audio consistently 136-148ms
  with no drift or degradation over the run
- Workflow structural validation: still passes (14 nodes now, down from 17, since the
  4-node chain collapsed into 1; zero orphaned connections)

### What this doesn't fix (real-world caveat)

This measurement is against a mocked LLM/TTS with near-zero network latency (everything
local). The *relative* improvement (buffered vs. pipelined) will hold with real APIs, but
real OpenAI + Sarvam network round trips will add real latency on top of both numbers —
pipelining reduces wasted serial waiting, it doesn't eliminate network time. Run
`benchmarks/latency_test.py` against your real deployment to get true numbers; the
sentence-chunking approach should still meaningfully help since sentence 1's TTS network
call now overlaps with the LLM still generating tokens for sentence 2+, rather than sitting
idle waiting.

### Independent re-verification with cache-isolated A/B testing

The measurement above (20-request sustained test) is a reasonable before/after snapshot,
but it doesn't fully isolate the variable — different runs, different query sets. I redid
it as a controlled experiment to be sure the ~68% figure holds up: same queries structure,
explicitly cache-isolated so neither arm's numbers could be contaminated by the other's
cached results.

**First attempt caught its own bug:** the first version of this A/B test ran through the
relay's WebSocket with a `mode` flag to toggle baseline vs. pipelined — but the relay
doesn't forward arbitrary fields like `mode` (correctly so; that's test-only plumbing that
has no business in production relay code), so every trial silently ran the same
(pipelined) code path. The "baseline" arm's results got cached, and the "pipelined" arm
then measured cache hits against those same cached entries — reporting a nonsensical 96.7%
"reduction" that was actually just measuring Redis cache-hit speed, not pipelining.

**Fixed by testing the n8n-webhook layer directly** (`qa/live_demo/ab_latency_test2.py`),
bypassing the relay with a purpose-built callback receiver, and using 12 genuinely unique
queries per arm (different text every single trial, both arms) so no cache overlap is
possible:

| | median | mean | min | max | n |
|---|---|---|---|---|---|
| Baseline (accumulate, then one TTS call) | 437.5ms | 430.4ms | 394.1ms | 466.1ms | 12 |
| Pipelined (per-sentence TTS) | 135.9ms | 135.5ms | 134.1ms | 136.9ms | 12 |

**Median reduction: 68.9%** — confirms the sustained-test figure above, now with a
methodologically clean, cache-isolated comparison.

**Full production-path distribution** (`qa/live_demo/prod_latency_test.py`, 16 fresh
queries through the actual relay WebSocket — no test-only toggles, the real code path):

| Metric | Result | Spec budget | Verdict |
|---|---|---|---|
| First-audio, median | 136.7ms | ≤1500ms target | PASS (90.7% headroom) |
| First-audio, p95 | 139.0ms | ≤2000ms hard max | PASS |
| Max inter-chunk gap | 139.2ms | never >500ms | PASS |

### Further latency levers (documented, not independently verified here)

- **Flush on commas too, not just sentence-ending punctuation** — would shrink "time to
  first clause" further in production, where real GPT token generation (not a local mock)
  dominates this latency. Trade-off: more, smaller TTS calls means more network round trips
  to Sarvam; only worth it if Sarvam's per-call overhead is small relative to the latency
  saved. Needs tuning against the real Sarvam API, not shipped blind.
- **HTTP keep-alive on the n8n→relay callback channel** — each `tts_chunk`/`llm_token`
  callback is its own HTTP POST; if your n8n version's HTTP Request node exposes a
  connection-reuse option, enable it. Not independently measurable here since callback
  overhead in this local sandbox is sub-millisecond.
- **Same-region deployment** (already noted in `docker-compose.yml`/README) — the single
  biggest real-world lever, and the one this sandbox categorically cannot demonstrate since
  there's no real network between components here.

## Bottom line

The parts of this system that are pure logic (chunking, prompt construction, cache
key generation, workflow graph structure) are implemented, unit-tested, and passing
12+7 tests with zero failures. The parts that require live third-party APIs (actual STT/TTS
audio, actual LLM calls, actual sub-2s latency numbers) are fully wired and ready to run in
your environment, but were not — and could not be — exercised end-to-end inside this
sandbox. Please run `benchmarks/latency_test.py` and QA_TEST_PLAN.md §3-6 once you deploy
with real keys, and treat those as the real acceptance gate before calling this
production-ready.
