# Production Deployment Status

**Status: NOT READY FOR PUBLIC DEMO**

The repository is prepared for deployment, but no Render/Vercel/Netlify domains, PostgreSQL
connection, hosted n8n URL, or production Sarvam credentials were available in this workspace.
No public deployment is claimed.

| Area | Status | Evidence |
|---|---|---|
| Backend health | PASS locally | `GET http://localhost:18090/health` via smoke test |
| Backend root | PASS locally | Smoke test |
| WebSocket `/` | PASS locally | Smoke test |
| WebSocket `/stt` | PASS locally | Socket acceptance verified; Sarvam upstream requires credentials/network |
| Action allow-list | PASS locally | Unsupported action rejected with HTTP 400 |
| Lead persistence | NOT VERIFIED | Requires `DATABASE_URL` PostgreSQL/Supabase |
| Frontend public load | NOT VERIFIED | No public static-host URL supplied |
| Sarvam STT | NOT VERIFIED | Requires production key and deployed backend |
| n8n/callback/TTS | NOT VERIFIED | Requires public n8n and callback URL |
| End-to-end voice | NOT VERIFIED | Requires all external services and microphone browser test |
| CRM | NOT CONFIGURED | No provider adapter credentials supplied |
| Security template | PASS | `.env.example` contains placeholders; `.gitignore` excludes `.env` |

## Automated checks executed

- `npm install`: passed in `backend/orchestrator`
- `npm test`: 15 tests passed
- `node scripts/smoke-test.js`: passed against local relay on port `18090`
- Node syntax checks: passed for backend and smoke-test files
- Lead validation and action-registry tests: passed
- Public URL checks: not possible without deployment access

## Required deployment verification

1. Provision Render, a static HTTPS host, PostgreSQL/Supabase, and hosted n8n.
2. Configure the variables in `.env.example`, especially `PORT`, `RELAY_CALLBACK_BASE_URL`,
   `FRONTEND_ORIGIN`, `DATABASE_URL`, `SARVAM_API_KEY`, and `N8N_WEBHOOK_URL`.
3. Set the real public backend URL in `frontend/config.js` and redeploy the static frontend.
4. Run `scripts/smoke-test.js` against the public `https`/`wss` URLs.
5. Execute real STT, n8n callback, TTS, lead persistence-after-restart, CRM, barge-in, and
   browser microphone tests. Record actual timings before calling the system production-ready.

## Action-layer status

Implemented and locally tested: allow-listed routing, structured errors, lead validation,
duplicate detection logic, PostgreSQL schema, contacts, deals, and tool definitions.

Not tested: a real PostgreSQL create/get/update/note transaction, restart persistence, CRM
provider delivery, and n8n tool-calling. `ACTION_ROUTER_URL` is configured as the integration
contract, but the existing imported n8n workflow still requires an explicit action/tool node to
invoke it; no end-to-end voice action claim is made.