#!/usr/bin/env python3
"""
Isolated A/B test of the n8n-side LLM->TTS strategy, bypassing the relay entirely (the
relay has no concept of 'mode' -- that's a test-only hook, appropriately absent from
production code -- so this talks directly to the mock n8n webhook with its own tiny
callback receiver instead of piggybacking on the relay's WebSocket).

Uses genuinely distinct, never-before-asked query text for every single trial (including
across baseline vs pipelined) so there is zero possibility of a cache hit contaminating
either measurement -- that's what went wrong in the first attempt at this comparison.
"""
import http.server
import json
import socketserver
import statistics
import threading
import time
import urllib.request

CALLBACK_PORT = 8099
received = {}  # turnId -> list of (time, payload)
done_events = {}  # turnId -> threading.Event


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        turn_id = self.path.split("/callback/")[1]
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        now = time.perf_counter()
        received.setdefault(turn_id, []).append((now, body))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
        if body.get("type") == "done":
            done_events[turn_id].set()


def start_callback_server():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", CALLBACK_PORT), CallbackHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


def run_turn(text, turn_id, mode):
    done_events[turn_id] = threading.Event()
    t0 = time.perf_counter()
    payload = json.dumps({
        "text": text, "turnId": turn_id, "isFinal": True, "mode": mode,
        "callbackUrl": f"http://localhost:{CALLBACK_PORT}/callback/{turn_id}",
    }).encode()
    req = urllib.request.Request("http://localhost:5678", data=payload,
                                  headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=5).read()

    done_events[turn_id].wait(timeout=10)
    events = received.get(turn_id, [])
    first_audio_ts = next((t for t, p in events if p.get("type") == "tts_chunk"), None)
    return (first_audio_ts - t0) * 1000 if first_audio_ts else None


# Genuinely unique queries for every trial, both modes -- guarantees no cache overlap.
TOPICS = [
    "return window for opened blenders", "shipping cost to rural addresses",
    "account deletion data retention period", "restocking fee on late returns",
    "express shipping surcharge amount", "two factor authentication setup steps",
    "warehouse locations for east coast orders", "lost package replacement timeline",
    "partial refund eligibility after 45 days", "customs delay for international orders",
    "updating saved payment methods safely", "tracking number email delivery timing",
]


def main():
    start_callback_server()
    time.sleep(0.3)

    baseline_results, pipelined_results = [], []

    print("BASELINE (accumulate full LLM answer, then one TTS call for everything):")
    for i, topic in enumerate(TOPICS):
        tid = f"ab2-baseline-{i}-{int(time.time()*1000)}"
        t = run_turn(f"Tell me about {topic}, trial {i}", tid, "baseline")
        print(f"  [{i+1}/{len(TOPICS)}] first_audio={t:.1f}ms" if t else f"  [{i+1}] FAILED")
        if t: baseline_results.append(t)

    print("\nPIPELINED (TTS per sentence, overlapped with ongoing LLM generation):")
    for i, topic in enumerate(TOPICS):
        tid = f"ab2-pipelined-{i}-{int(time.time()*1000)}"
        t = run_turn(f"Explain the policy on {topic}, case {i}", tid, "pipelined")
        print(f"  [{i+1}/{len(TOPICS)}] first_audio={t:.1f}ms" if t else f"  [{i+1}] FAILED")
        if t: pipelined_results.append(t)

    print(f"\n{'='*70}")
    b_med, p_med = statistics.median(baseline_results), statistics.median(pipelined_results)
    print(f"{'BASELINE (old, unpipelined)':32s} median={b_med:7.1f}ms  mean={statistics.mean(baseline_results):7.1f}ms  "
          f"min={min(baseline_results):7.1f}ms  max={max(baseline_results):7.1f}ms  n={len(baseline_results)}")
    print(f"{'PIPELINED (new, per-sentence)':32s} median={p_med:7.1f}ms  mean={statistics.mean(pipelined_results):7.1f}ms  "
          f"min={min(pipelined_results):7.1f}ms  max={max(pipelined_results):7.1f}ms  n={len(pipelined_results)}")
    print(f"\nMedian first-audio latency reduction: {(1 - p_med / b_med) * 100:.1f}%")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
