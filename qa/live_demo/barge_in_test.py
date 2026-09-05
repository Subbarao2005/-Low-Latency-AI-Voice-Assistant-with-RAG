#!/usr/bin/env python3
"""
Barge-in test: opens ONE WebSocket connection (like a single browser tab), sends turn A,
waits a short delay (simulating the user starting to speak again before turn A's audio
finishes), then sends turn B on the SAME connection -- and logs every message tagged with
its turnId so we can see whether turn A's stale audio still arrives after turn B starts.
"""
import asyncio
import json
import sys
import time

import websockets


async def main(url, delay_ms):
    async with websockets.connect(url) as ws:
        t0 = time.perf_counter()
        turn_a = f"turnA-{int(time.time()*1000)}"
        turn_b = f"turnB-{int(time.time()*1000)}"

        print(f"[+{0:7.1f}ms] sending TURN A: 'What is the return window for opened electronics?' (turnId={turn_a})")
        await ws.send(json.dumps({"type": "transcript", "text": "What is the return window for opened electronics?",
                                   "isFinal": True, "turnId": turn_a}))

        await asyncio.sleep(delay_ms / 1000)
        elapsed = (time.perf_counter() - t0) * 1000
        print(f"[+{elapsed:7.1f}ms] BARGE-IN: sending TURN B: 'Can I change my shipping address after ordering?' (turnId={turn_b})")
        await ws.send(json.dumps({"type": "transcript", "text": "Can I change my shipping address after ordering?",
                                   "isFinal": True, "turnId": turn_b}))
        print(f"[+{elapsed:7.1f}ms] (client-side: real frontend would call stopPlayback() here)")

        done_count = 0
        turn_a_chunks_after_bargein = 0
        while done_count < 2:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=8)
            except asyncio.TimeoutError:
                print("timed out waiting for remaining messages")
                break
            now = (time.perf_counter() - t0) * 1000
            msg = json.loads(raw)
            tid = msg.get("turnId", "?")
            which = "A" if tid == turn_a else ("B" if tid == turn_b else "?")

            if msg["type"] == "tts_chunk" and which == "A" and now > elapsed:
                turn_a_chunks_after_bargein += 1

            print(f"[+{now:7.1f}ms] [turn {which}] {msg['type']}"
                  + (f" seq={msg['seq']}" if msg["type"] == "tts_chunk" else ""))

            if msg["type"] == "done":
                done_count += 1

        print(f"\n{'='*60}")
        print(f"RESULT: {turn_a_chunks_after_bargein} of turn A's audio chunks arrived AFTER "
              f"the barge-in point.")
        if turn_a_chunks_after_bargein > 0:
            print("FINDING: the relay has no concept of 'this turn was superseded' -- it will "
                  "happily keep forwarding turn A's stale audio to the browser even after turn B "
                  "started. The frontend's stopPlayback() only clears the LOCAL audio queue/context; "
                  "it does not tell the relay/server to stop sending turn A's remaining chunks. If "
                  "those stale chunks arrive after stopPlayback() already ran, frontend/app.js's "
                  "enqueueAudioChunk() will lazily recreate state.audioCtx and play them anyway, "
                  "since it has no turnId filter (see handleRelayMessage in app.js).")
        print(f"{'='*60}")


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8090"
    delay_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    asyncio.run(main(url, delay_ms))
