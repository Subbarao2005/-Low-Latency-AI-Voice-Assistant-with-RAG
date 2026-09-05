# Live demo scripts (no API keys required)

These are the exact scripts used to run a live, functional end-to-end test of this
project without needing Sarvam/OpenAI credentials — useful for smoke-testing the
orchestration logic (relay, Redis cache, Qdrant retrieval, workflow control-flow) before
you plug in real keys.

## What's real vs. mocked

- Real: Redis, Qdrant (embedded/local mode), the actual `backend/orchestrator/server.js`
  relay, the actual WebSocket protocol the frontend speaks.
- Mocked: `mock_n8n.py` stands in for `backend/n8n/workflow.json` — same control flow
  (cache check → retrieval → prompt build → stream tokens → stream audio → cache write),
  but a canned answer instead of GPT and a synthesized beep instead of Sarvam TTS.

## Run it yourself

```bash
# 1. Redis
apt-get install -y redis-server
redis-server --daemonize yes --port 6379

# 2. Ingest the demo docs (uses ../backend/ingest/ingest_demo.py's local hashing embedder,
#    not OpenAI -- swap for the real ingest.py once you have an OPENAI_API_KEY)
cd ../../backend/ingest && python3 ingest_demo.py && cd -

# 3. Mock n8n webhook
python3 mock_n8n.py &

# 4. Real streaming relay
cd ../../backend/orchestrator && npm install && \
  RELAY_PORT=8090 N8N_WEBHOOK_URL=http://localhost:5678 node server.js &
cd -

# 5. Drive it like the frontend would
python3 live_client.py ws://localhost:8090 "What is your refund policy?"
```

See `../test_results.md` §7 for the actual results and a bug this workflow caught
(empty-transcript handling), now fixed in `../../backend/n8n/workflow.json`.

## Additional live tests run

- `barge_in_test.py <ws_url> <delay_ms>` — reproduces the barge-in race (turn A, then
  turn B on the same connection before A finishes) and reports how many of turn A's
  audio chunks leak through after the barge-in point. Should report 0 on the current
  `server.js`; see `../test_results.md` "Bug #2" for the fix history.
- `sustained_test.py` — runs 20 sequential distinct queries and reports per-request
  latency + pass/fail, useful for spotting degradation or leaks over a longer session.

## Latency optimization verification (primary judging criterion)

- `ab_latency_test2.py` — controlled A/B test of baseline (accumulate-then-TTS) vs.
  pipelined (per-sentence TTS) first-audio latency. Talks directly to the mock n8n
  webhook with its own callback receiver (bypasses the relay, which correctly has no
  `mode` toggle in production). Uses 12 genuinely unique queries per arm so no cache hit
  can contaminate either measurement. Result: 437.5ms → 135.9ms median (68.9% reduction).
- `prod_latency_test.py` — full end-to-end distribution through the real relay
  WebSocket (no toggles, the actual production code path), 16 fresh queries. Result:
  136.7ms median / 139.0ms p95 first-audio, 90.7% headroom under the 1500ms target.

See `../test_results.md` §8 for the full writeup, including a methodology bug this
caught in its own first attempt (cache contamination from a mode flag that the relay
correctly doesn't forward).
