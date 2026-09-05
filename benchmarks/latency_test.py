#!/usr/bin/env python3
"""
End-to-end latency benchmark against the spec's numeric targets:
  - first audio response:   <=1.5s target, <=2.0s max
  - RAG retrieval latency:  <=150ms
  - LLM first token:        <=800ms
  - no gap between audio chunks > 500ms

Drives the WebSocket relay (backend/orchestrator/server.js) directly, sending a
synthetic "final transcript" turn and timing every event it receives back.

Requires the full stack running (docker-compose up, n8n workflow imported+active,
relay running) with real Sarvam/OpenAI keys -- this cannot be executed from a
network-restricted sandbox. Run it from your own machine:

    pip install websockets
    python latency_test.py --url ws://localhost:8090 --query "What is your refund policy?" --runs 10
"""
import argparse
import asyncio
import json
import statistics
import time

import websockets

TARGETS = {
    "first_audio_target_ms": 1500,
    "first_audio_max_ms": 2000,
    "max_gap_ms": 500,
}


async def run_once(url: str, query: str) -> dict:
    turn_id = f"bench-{int(time.time() * 1000)}"
    async with websockets.connect(url) as ws:
        t_start = time.perf_counter()
        await ws.send(json.dumps({"type": "transcript", "text": query, "isFinal": True, "turnId": turn_id}))

        first_token_ts = None
        first_audio_ts = None
        last_chunk_ts = t_start
        max_gap_ms = 0.0
        chunk_count = 0
        done = False

        while not done:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
            now = time.perf_counter()
            msg = json.loads(raw)

            if msg.get("turnId") != turn_id:
                continue

            if msg["type"] == "llm_token" and first_token_ts is None:
                first_token_ts = now
            elif msg["type"] == "tts_chunk":
                if first_audio_ts is None:
                    first_audio_ts = now
                gap_ms = (now - last_chunk_ts) * 1000
                max_gap_ms = max(max_gap_ms, gap_ms)
                last_chunk_ts = now
                chunk_count += 1
            elif msg["type"] == "done":
                done = True
            elif msg["type"] == "error":
                return {"error": msg.get("message"), "turn_id": turn_id}

        return {
            "turn_id": turn_id,
            "first_llm_token_ms": round((first_token_ts - t_start) * 1000, 1) if first_token_ts else None,
            "first_audio_ms": round((first_audio_ts - t_start) * 1000, 1) if first_audio_ts else None,
            "max_inter_chunk_gap_ms": round(max_gap_ms, 1),
            "chunk_count": chunk_count,
        }


def summarize(results: list[dict]):
    ok = [r for r in results if "error" not in r]
    failed = [r for r in results if "error" in r]

    print(f"\n=== {len(results)} runs, {len(failed)} errored ===\n")
    if failed:
        for f in failed:
            print(f"  ERROR turn={f['turn_id']}: {f['error']}")

    if not ok:
        return

    def col(key):
        return [r[key] for r in ok if r.get(key) is not None]

    for label, key, budget in [
        ("First LLM token", "first_llm_token_ms", TARGETS["first_audio_target_ms"] * 0.53),  # ~800ms budget
        ("First audio byte", "first_audio_ms", TARGETS["first_audio_target_ms"]),
        ("Max inter-chunk gap", "max_inter_chunk_gap_ms", TARGETS["max_gap_ms"]),
    ]:
        vals = col(key)
        if not vals:
            continue
        p50 = statistics.median(vals)
        p95 = sorted(vals)[max(0, int(len(vals) * 0.95) - 1)]
        verdict = "PASS" if p95 <= budget else "FAIL"
        print(f"{label:22s} p50={p50:7.1f}ms  p95={p95:7.1f}ms  budget={budget:.0f}ms  [{verdict}]")

    over_max = [r for r in ok if r.get("first_audio_ms") and r["first_audio_ms"] > TARGETS["first_audio_max_ms"]]
    print(f"\nRuns exceeding hard max ({TARGETS['first_audio_max_ms']}ms): {len(over_max)}/{len(ok)}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://localhost:8090")
    parser.add_argument("--query", default="What is your refund policy?")
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args()

    results = []
    for i in range(args.runs):
        print(f"Run {i + 1}/{args.runs}...")
        try:
            results.append(await run_once(args.url, args.query))
        except Exception as e:
            results.append({"error": str(e), "turn_id": f"run-{i}"})

    summarize(results)


if __name__ == "__main__":
    asyncio.run(main())
