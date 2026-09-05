#!/usr/bin/env python3
"""
Full end-to-end latency distribution through the REAL production path: relay WebSocket,
exactly as frontend/app.js talks to it, with the current (pipelined) mock n8n behind it.
No test-only toggles -- this is what a real user's first-audio latency looks like.
"""
import asyncio
import json
import statistics
import time

import websockets

TOPICS = [
    "the exchange policy for gift purchases", "how weekend orders get processed",
    "whether damaged items need photos for a claim", "the cutoff time for same-day dispatch",
    "how to merge two customer accounts", "the process for a price-match request",
    "what happens to unclaimed refunds after a year", "how bulk orders are invoiced",
    "the warranty period on electronics", "how to escalate a delayed shipment",
    "the process for updating a delivery address mid-transit", "whether store credit expires",
    "how loyalty points are calculated", "the steps to dispute a charge",
    "how seasonal promotions stack with coupons", "the policy on international returns",
]


async def run_one(url, query, turn_id):
    async with websockets.connect(url) as ws:
        t0 = time.perf_counter()
        await ws.send(json.dumps({"type": "transcript", "text": query, "isFinal": True, "turnId": turn_id}))
        first_audio_ms = None
        max_gap_ms = 0.0
        last_ts = t0
        chunk_count = 0
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            now = time.perf_counter()
            msg = json.loads(raw)
            if msg["type"] == "tts_chunk":
                if first_audio_ms is None:
                    first_audio_ms = (now - t0) * 1000
                gap_ms = (now - last_ts) * 1000
                max_gap_ms = max(max_gap_ms, gap_ms)
                last_ts = now
                chunk_count += 1
            elif msg["type"] == "done":
                break
        return first_audio_ms, max_gap_ms, chunk_count


async def main():
    url = "ws://localhost:8090"
    results = []
    for i, topic in enumerate(TOPICS):
        tid = f"prod-{i}-{int(time.time()*1000)}"
        first_audio, max_gap, chunks = await run_one(url, f"What is {topic}?", tid)
        print(f"[{i+1:2d}/{len(TOPICS)}] first_audio={first_audio:6.1f}ms  "
              f"max_inter_chunk_gap={max_gap:6.1f}ms  chunks={chunks}")
        results.append((first_audio, max_gap, chunks))

    first_audios = [r[0] for r in results]
    gaps = [r[1] for r in results]

    print(f"\n{'='*70}")
    print("FIRST-AUDIO LATENCY (spec: <=1500ms target, <=2000ms hard max)")
    p50 = statistics.median(first_audios)
    p95 = sorted(first_audios)[max(0, int(len(first_audios) * 0.95) - 1)]
    print(f"  median={p50:.1f}ms  p95={p95:.1f}ms  min={min(first_audios):.1f}ms  max={max(first_audios):.1f}ms")
    print(f"  verdict: {'PASS' if p95 <= 2000 else 'FAIL'} (p95 vs 2000ms hard max), "
          f"{'PASS' if p95 <= 1500 else 'FAIL'} (p95 vs 1500ms target)")
    print(f"  margin under target: {1500 - p95:.1f}ms ({(1 - p95/1500)*100:.1f}% headroom)" if p95 <= 1500
          else f"  OVER target by {p95 - 1500:.1f}ms")

    print(f"\nMAX INTER-CHUNK GAP (spec: never >500ms)")
    print(f"  median={statistics.median(gaps):.1f}ms  max_observed={max(gaps):.1f}ms  "
          f"verdict: {'PASS' if max(gaps) <= 500 else 'FAIL'}")
    print(f"{'='*70}")


if __name__ == "__main__":
    asyncio.run(main())
