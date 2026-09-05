#!/usr/bin/env python3
"""
Acts exactly like frontend/app.js's relay connection: opens a WebSocket to the relay,
sends a {type: 'transcript', ...} message, and logs every chunk it receives back with
real elapsed-time measurements -- the same events the browser's handleRelayMessage()
would process.
"""
import asyncio
import json
import sys
import time

import websockets


async def run_turn(url: str, text: str, turn_id: str):
    async with websockets.connect(url) as ws:
        t0 = time.perf_counter()
        print(f"\n{'='*70}")
        print(f"CLIENT: connected to relay, sending turn '{turn_id}'")
        print(f"CLIENT: transcript = \"{text}\"")
        print(f"{'='*70}")

        await ws.send(json.dumps({"type": "transcript", "text": text, "isFinal": True, "turnId": turn_id}))

        assistant_text = ""
        chunk_count = 0
        first_token_ms = None
        first_audio_ms = None

        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
            except asyncio.TimeoutError:
                print("CLIENT: timed out waiting for next message")
                break
            elapsed = (time.perf_counter() - t0) * 1000
            msg = json.loads(raw)

            if msg["type"] == "llm_token":
                if first_token_ms is None:
                    first_token_ms = elapsed
                    print(f"[+{elapsed:7.1f}ms] first LLM token arrived")
                assistant_text += msg["text"]
            elif msg["type"] == "tts_chunk":
                chunk_count += 1
                if first_audio_ms is None:
                    first_audio_ms = elapsed
                    print(f"[+{elapsed:7.1f}ms] *** FIRST AUDIO CHUNK *** "
                          f"(spec target <=1500ms, hard max <=2000ms) -> "
                          f"{'PASS' if elapsed <= 2000 else 'FAIL'}")
                print(f"[+{elapsed:7.1f}ms] audio chunk seq={msg['seq']} "
                      f"({len(msg['audio_b64'])} b64 chars)")
            elif msg["type"] == "done":
                print(f"[+{elapsed:7.1f}ms] done signal received")
                break
            elif msg["type"] == "error":
                print(f"[+{elapsed:7.1f}ms] ERROR: {msg['message']}")
                break

        print(f"\nCLIENT: full assistant text received:\n  \"{assistant_text.strip()}\"")
        print(f"CLIENT: summary -- first_token={first_token_ms}ms first_audio={first_audio_ms}ms "
              f"chunks={chunk_count} total={elapsed:.1f}ms")
        return {"first_token_ms": first_token_ms, "first_audio_ms": first_audio_ms,
                "chunks": chunk_count, "total_ms": elapsed}


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8090"
    text = sys.argv[2] if len(sys.argv) > 2 else "What is your refund policy?"
    turn_id = f"live-{int(time.time()*1000)}"
    asyncio.run(run_turn(url, text, turn_id))
