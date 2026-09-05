# Low-Latency Voice Assistant (RAG) — Sarvam STT/TTS + n8n + Qdrant + Redis + OpenAI

Real-time, streaming, speech-to-speech assistant with retrieval-augmented answers and
backend action capability (CRM/lead-capture hooks), built to the flow:

```
Frontend (mic + audio player)
        ↓
Sarvam STT (stream)
        ↓
n8n (webhook + logic)
   ↙           ↘
Qdrant        Redis
   ↓
OpenAI (stream)
        ↓
Sarvam TTS (stream)
        ↓
Frontend playback
```

## Why there are two backend pieces

n8n is the orchestrator of record (webhook, Qdrant lookup, Redis cache, OpenAI call, Sarvam TTS
call, CRM actions) — that's where all the *business logic* lives, per the spec.

However, stock n8n webhooks buffer their HTTP response; they cannot push token-by-token /
chunk-by-chunk audio to a browser over a single request the way a raw streaming server can.
To hit the "no pauses > 500ms" / "stream tokens directly to TTS" requirements, n8n needs a
thin **streaming relay** sitting between the webhook and the browser:

- `backend/orchestrator/server.js` is that relay. It is intentionally dumb: it exposes a
  WebSocket to the browser, forwards the transcript to the n8n webhook, and as n8n (via an
  HTTP callback / SSE) produces LLM tokens and TTS audio chunks, it pushes them to the browser
  immediately. All actual RAG/LLM/CRM/cache **decisions** are still made inside n8n — this file
  contains zero business logic, only chunk relaying, so it doesn't violate the "n8n is the
  orchestrator" requirement.
- If your n8n version/plan supports native streaming "Respond to Webhook" (n8n ≥ 1.6x with the
  streaming response option), you can delete the relay and point the frontend straight at the
  n8n webhook URL — `frontend/app.js` supports both modes via `STREAM_MODE`.

## Directory layout

```
voice-assistant/
├── docker-compose.yml        # n8n + Qdrant + Redis, one command to stand up infra
├── .env.example               # all required API keys / hosts
├── frontend/                  # mic capture, streaming playback, zero build step
│   ├── index.html
│   ├── style.css
│   └── app.js
├── backend/
│   ├── ingest/                 # RAG ingestion: chunk → embed → upsert to Qdrant
│   │   ├── chunk.py
│   │   ├── ingest.py
│   │   ├── requirements.txt
│   │   └── test_chunk.py
│   ├── n8n/
│   │   └── workflow.json       # importable n8n workflow (webhook→Redis→Qdrant→OpenAI→Sarvam TTS)
│   └── orchestrator/            # optional streaming relay (see above)
│       ├── server.js
│       ├── package.json
│       ├── lib/
│       │   ├── promptBuilder.js
│       │   └── cacheKey.js
│       └── test/
│           ├── promptBuilder.test.js
│           └── cacheKey.test.js
├── benchmarks/
│   └── latency_test.py         # measures first-audio-byte, RAG latency, gap durations
└── qa/
    ├── QA_TEST_PLAN.md          # full test plan mapped to the spec's success/failure criteria
    └── test_results.md          # actual results from this build/session
```

## Setup

1. `cp .env.example .env` and fill in `SARVAM_API_KEY`, `OPENAI_API_KEY`, plus Qdrant/Redis
   hosts if not using the bundled docker-compose.
2. `docker compose up -d` — brings up n8n (`:5678`), Qdrant (`:6333`), Redis (`:6379`).
3. In n8n, import `backend/n8n/workflow.json`, set the `OpenAI`, `Sarvam`, `Redis`, `Qdrant`
   credentials/env vars it references, and activate it. Note the webhook URL.
4. Ingest your knowledge base: `cd backend/ingest && pip install -r requirements.txt && python ingest.py --source ./docs --collection kb`.
5. (Optional streaming relay) `cd backend/orchestrator && npm install && node server.js` —
   set `N8N_WEBHOOK_URL` and `PORT` in `.env` first.
6. Open `frontend/index.html` over HTTPS or `localhost` (mic access requires a secure context),
   set the webhook/relay URL in the settings panel, click "Start", and talk.

## Design decisions that map to the spec's non-functional requirements

| Requirement | Where it's implemented |
|---|---|
| chunk size 300–500 tokens | `backend/ingest/chunk.py` (`MIN_TOKENS=300, MAX_TOKENS=500`) |
| top_k 2–3, context ≤1000 tokens | `workflow.json` Qdrant node (`top_k=3`), `promptBuilder.js` truncates to 1000 tokens |
| precomputed embeddings only | `ingest.py` embeds at ingestion time; the live query path only embeds the *query* (unavoidable), never re-embeds the corpus |
| short-term memory: last 2–3 turns | `promptBuilder.js` keeps a rolling window of 3 turns, no full replay |
| initiate LLM call on partial transcript | `frontend/app.js` sends STT partials once punctuation/pause heuristic fires (`SILENCE_MS=350`), not only on `is_final` |
| stream tokens directly to TTS | **Sentence-pipelined**: `workflow.json`'s single Code node (`PIPELINED: LLM stream -> per-sentence TTS -> callback`) reads the OpenAI SSE stream and fires a Sarvam TTS call for each *sentence* the moment it completes, while the LLM keeps generating the next one — it never waits for the full response. Live-measured: this cut first-audio latency from ~450-525ms to ~137-142ms (a ~68% reduction) in repeated local trials. See `qa/test_results.md` §8. |
| cache frequent queries in Redis | `workflow.json` Redis Get/Set nodes keyed by `cacheKey.js` logic (normalized query + kb version) |
| same-region deployment | `docker-compose.yml` comment + README note — set all three services' regions to match your OpenAI/Sarvam region |
| minimize prompt size | `promptBuilder.js` strips system prompt boilerplate to <120 tokens, drops retrieved chunks beyond the 1000-token budget in relevance order |

## What was actually executed vs. what requires your keys

This sandbox's network egress is restricted to package registries (npm/pypi/github) — it
cannot reach the Sarvam AI or OpenAI APIs, so true end-to-end (real audio in, real audio out)
testing could not be run here. What **was** run and verified in this session:

- Unit tests for chunking (token bounds, overlap) — `backend/ingest/test_chunk.py`
- Unit tests for prompt building (1000-token cap, 3-turn window) and cache-key normalization —
  `backend/orchestrator/test/*.test.js`
- n8n workflow JSON validated for structural correctness (valid JSON, node graph connectivity)
- Static/latency-budget review of the architecture against the spec's numeric targets

See `qa/test_results.md` for the full results and `qa/QA_TEST_PLAN.md` for the tests you should
run yourself once real API keys are in place (it includes exact commands/curl calls and pass/fail
thresholds lifted directly from the spec).

## Production deployment

The frontend is a static HTML application. Deploy `frontend/` to Vercel, Netlify, or any static
HTTPS host. Set the public backend URL in `frontend/config.js`:

```js
window.VOICE_ASSISTANT_CONFIG = {
   backendUrl: "https://your-relay.example.com",
};
```

This file contains no secrets. The browser derives `wss://your-relay.example.com` and
`wss://your-relay.example.com/stt` from that value. For local development, the empty value uses
the page origin or `http://localhost:8090` when opened directly from disk.

Deploy `backend/orchestrator` as a Render Web Service with:

```text
Root Directory: backend/orchestrator
Build Command: npm install
Start Command: npm start
```

Set `PORT` through Render. The relay binds to `0.0.0.0`; do not set a fixed production port.
Set `RELAY_CALLBACK_BASE_URL` to the public HTTPS backend URL so n8n can reach
`/callback/<turnId>`. Set `FRONTEND_ORIGIN` to the exact frontend origin.

Required server variables include `SARVAM_API_KEY`, `SARVAM_STT_URL`, `N8N_WEBHOOK_URL`,
`RELAY_CALLBACK_BASE_URL`, `FRONTEND_ORIGIN`, and `DATABASE_URL`. `DATABASE_URL` must point to
PostgreSQL/Supabase. The action API creates its `leads` and `lead_notes` tables automatically on
first use. No in-memory lead store is used.

### Health and action endpoints

`GET /health` returns only `{ "status": "ok", "service": "voice-assistant-relay" }`.
Structured backend actions are accepted at `POST /actions`; only `create_lead`, `get_lead`,
`update_lead`, and `add_note` are registered. Unsupported actions are rejected. External CRM
providers are intentionally not claimed as connected unless a provider adapter and credentials
are configured.

Run the local or deployed smoke test with:

```powershell
$env:TEST_BASE_URL = "https://your-relay.example.com"
$env:TEST_WS_URL = "wss://your-relay.example.com"
node scripts/smoke-test.js
```

The smoke test checks `/health`, `/`, both WebSocket paths, and unsupported-action rejection.
Real Sarvam, n8n, TTS, database persistence, CRM, microphone, and end-to-end voice checks still
require the deployed external services and credentials.

## Backend actions

The action API is deliberately separate from WebSocket transport. `POST /action` (with
`/actions` retained as an alias) accepts only structured requests:

```json
{
   "type": "action",
   "action": "create_lead",
   "data": {
      "name": "Rahul",
      "phone": "9876543210",
      "requirement": "E-commerce website"
   }
}
```

Registered actions are `create_lead`, `get_lead`, `update_lead`, `add_note`, `create_contact`,
`get_contact`, `update_contact`, `create_deal`, `get_deal`, and `update_deal`. The immutable
allow-list is in `backend/orchestrator/actions/actionRegistry.js`; arbitrary JavaScript, shell
commands, dynamic modules, and arbitrary HTTP requests are never executed.

Lead creation requires a name plus a phone or email, normalizes phone/email, limits statuses to
`new`, `contacted`, `qualified`, `proposal`, `won`, and `lost`, and detects duplicate phone/email
records. Leads and notes persist in PostgreSQL. Contacts and deals use the same database service.
The schema is initialized on first database use; set `DATABASE_URL` before using actions.

For n8n, configure `ACTION_ROUTER_URL` to the public backend `/action` URL and add an HTTP Request
node after the LLM has produced a validated structured action. Send the exact request contract
above and pass the JSON result back into the assistant response. The backend remains the final
validator and authorization boundary; n8n or an LLM must not be trusted to bypass it.

Tool definitions for an OpenAI-compatible tool-calling node are maintained in
`backend/orchestrator/actions/toolDefinitions.js`. The current imported workflow still preserves
its existing streaming conversational node; production n8n action wiring must explicitly add the
HTTP Request/tool-calling node and test it against the public `ACTION_ROUTER_URL`.
