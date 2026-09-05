#!/usr/bin/env python3
"""
LIVE DEMO stand-in for the n8n workflow (backend/n8n/workflow.json).

Implements the EXACT same control flow as the real workflow:
  receive transcript -> normalize -> Redis cache check -> (hit: return cached audio)
  (miss: Qdrant retrieval -> build prompt -> stream "LLM tokens" -> stream "TTS audio"
   -> POST each chunk to the callback URL as it's produced -> write-through cache)

What's REAL: Redis GET/SET (actual redis-server), Qdrant search (actual embedded Qdrant),
the cache-key normalization, the prompt/context-token-budget logic, the chunk-by-chunk
streaming behavior and timing.

What's MOCKED (no OpenAI/Sarvam key available in this sandbox): the LLM response text is
a canned template built from the retrieved chunk instead of a real GPT completion, and the
"audio" is a tiny valid WAV file (a sine-wave beep) base64-encoded per chunk instead of real
Sarvam speech synthesis. Both are clearly labeled in the logs below as they fire.
"""
import base64
import hashlib
import http.server
import io
import json
import math
import socketserver
import struct
import sys
import threading
import time
import wave

import redis
sys.path.insert(0, "/home/claude/voice-assistant/backend/ingest")
from ingest_demo import embed  # noqa: E402
from qdrant_client import QdrantClient  # noqa: E402

r = redis.Redis(host="localhost", port=6379, decode_responses=True)
qdrant = QdrantClient(path="/home/claude/qdrant_local_data")

CACHE_TTL = 3600


def log(msg):
    print(f"[mock-n8n {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def normalize(q: str) -> str:
    import re
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", q.lower())).strip()


def make_beep_wav_b64(freq=440, duration_s=0.3, sample_rate=8000):
    """Generates a tiny real, valid WAV file (sine tone) as a stand-in for Sarvam TTS audio."""
    n_samples = int(sample_rate * duration_s)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        for i in range(n_samples):
            val = int(3000 * math.sin(2 * math.pi * freq * i / sample_rate))
            wf.writeframesraw(struct.pack("<h", val))
    return base64.b64encode(buf.getvalue()).decode()


def post_callback(url, payload):
    import urllib.request
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=5).read()


def process_turn_baseline(body, t_start, text, turn_id, callback_url, kept):
    """OLD (unpipelined) design, kept only for live A/B comparison: accumulate the ENTIRE
    LLM answer first, THEN make one TTS call for the whole thing. This is what the
    pipelined version above replaced -- see qa/test_results.md 'Latency optimization'."""
    best = kept[0] if kept else "I don't have information on that."
    answer_text = f"[MOCK LLM -- real deployment calls GPT] Based on our docs: {best[:180]}..."
    tokens = answer_text.split()

    for tok in tokens:
        post_callback(callback_url, {"type": "llm_token", "text": tok + " "})
        time.sleep(0.01)

    # TTS only starts here, AFTER the entire answer has streamed -- this is the wait we're
    # eliminating with the pipelined version.
    for seq in range(3):
        audio_b64 = make_beep_wav_b64(freq=440 + seq * 80)
        post_callback(callback_url, {"type": "tts_chunk", "audio_b64": audio_b64, "seq": seq})
        time.sleep(0.05)

    post_callback(callback_url, {"type": "done"})
    total_ms = (time.perf_counter() - t_start) * 1000
    log(f"turn={turn_id} [BASELINE mode] done in {total_ms:.1f}ms")


def process_turn(body):
    t_start = time.perf_counter()
    text = body.get("text", "").strip()
    turn_id = body.get("turnId")
    callback_url = body.get("callbackUrl")
    baseline_mode = body.get("mode") == "baseline"
    cache_key = f"qa:kb_demo:{normalize(text)}"

    log(f"turn={turn_id} received transcript: \"{text}\"")

    if not text:
        log(f"turn={turn_id} REJECTED -- empty transcript, not running pipeline")
        post_callback(callback_url, {"type": "error", "message": "empty transcript"})
        return

    if baseline_mode:
        cache_key = f"{cache_key}:baseline:{turn_id}"  # unique per-call, always cold for fair A/B

    log(f"turn={turn_id} cache key = {cache_key}")

    cached = r.get(cache_key)
    if cached:
        log(f"turn={turn_id} CACHE HIT -- skipping Qdrant + LLM + TTS entirely")
        cached_obj = json.loads(cached)
        post_callback(callback_url, {"type": "llm_token", "text": cached_obj["answer_text"]})
        post_callback(callback_url, {"type": "tts_chunk", "audio_b64": cached_obj["audio_b64"], "seq": 0})
        post_callback(callback_url, {"type": "done"})
        elapsed = (time.perf_counter() - t_start) * 1000
        log(f"turn={turn_id} done in {elapsed:.1f}ms (cache path)")
        return

    log(f"turn={turn_id} CACHE MISS -- running full pipeline")

    # --- Real Qdrant retrieval ---
    t_retrieval_start = time.perf_counter()
    vec = embed(text)
    results = qdrant.query_points(collection_name="kb_demo", query=vec, limit=3, with_payload=True).points
    retrieval_ms = (time.perf_counter() - t_retrieval_start) * 1000
    top_chunks = [res.payload["text"] for res in results]
    log(f"turn={turn_id} Qdrant retrieval took {retrieval_ms:.2f}ms, "
        f"top match doc={results[0].payload['doc_id'] if results else 'none'} score={results[0].score:.3f}" if results else "no results")

    # --- Context budget enforcement (same logic as promptBuilder.js) ---
    MAX_CONTEXT_TOKENS = 1000
    kept, used = [], 0
    for c in top_chunks:
        t = math.ceil(len(c.split()) * 1.3)
        if used + t > MAX_CONTEXT_TOKENS:
            break
        kept.append(c)
        used += t
    log(f"turn={turn_id} context budget: {used}/{MAX_CONTEXT_TOKENS} tokens used, {len(kept)} chunk(s) kept")

    if baseline_mode:
        return process_turn_baseline(body, t_start, text, turn_id, callback_url, kept)

    # --- MOCKED LLM + TTS, PIPELINED: synthesize+send audio per SENTENCE as soon as it
    # completes, instead of waiting for the full LLM response. This is the single biggest
    # latency lever in a streaming voice pipeline -- in the old (unpipelined) version,
    # first-audio had to wait for the entire ~40-token answer to finish generating before
    # TTS even started. Now TTS for sentence N fires while the LLM is still generating
    # sentence N+1, so first-audio only waits for the FIRST sentence, not the whole answer.
    t_llm_start = time.perf_counter()
    best = kept[0] if kept else "I don't have information on that."
    answer_text = f"[MOCK LLM -- real deployment calls GPT] Based on our docs: {best[:180]}..."
    tokens = answer_text.split()

    first_token_ms = None
    first_audio_ms = None
    sentence_buf = []
    seq = 0
    SENTENCE_END_CHARS = (".", "!", "?")
    MAX_WORDS_BEFORE_FORCED_FLUSH = 12  # don't let a run-on clause with no punctuation stall TTS

    def flush_sentence(words, is_final_flush=False):
        """Fires a TTS request for the accumulated sentence buffer immediately -- this is
        what overlaps TTS synthesis with ongoing LLM generation."""
        nonlocal seq, first_audio_ms
        if not words:
            return
        text_piece = " ".join(words)
        audio_b64 = make_beep_wav_b64(freq=440 + seq * 60)
        if first_audio_ms is None:
            first_audio_ms = (time.perf_counter() - t_start) * 1000
            log(f"turn={turn_id} *** FIRST AUDIO (pipelined) at {first_audio_ms:.1f}ms *** "
                f"-- sentence was: \"{text_piece[:60]}\"")
        post_callback(callback_url, {"type": "tts_chunk", "audio_b64": audio_b64, "seq": seq,
                                      "sentence_text": text_piece})
        log(f"turn={turn_id} TTS fired for sentence seq={seq} ({len(words)} words): \"{text_piece[:50]}\"")
        seq += 1

    for i, tok in enumerate(tokens):
        if first_token_ms is None:
            first_token_ms = (time.perf_counter() - t_llm_start) * 1000
        post_callback(callback_url, {"type": "llm_token", "text": tok + " "})
        sentence_buf.append(tok)
        time.sleep(0.01)  # simulate token-by-token streaming pacing (real GPT ~ similar order)

        ends_sentence = tok.rstrip().endswith(SENTENCE_END_CHARS)
        forced_flush = len(sentence_buf) >= MAX_WORDS_BEFORE_FORCED_FLUSH
        if ends_sentence or forced_flush:
            flush_sentence(sentence_buf)
            sentence_buf = []

    flush_sentence(sentence_buf, is_final_flush=True)  # trailing partial sentence, if any

    log(f"turn={turn_id} MOCK LLM+TTS pipelined: first token at {first_token_ms:.1f}ms, "
        f"first audio at {first_audio_ms:.1f}ms, {seq} sentence-chunk(s) synthesized "
        f"(spec budgets: token<=800ms, audio<=1500ms target/2000ms max)")

    post_callback(callback_url, {"type": "done"})

    # --- Write-through cache (real Redis) ---
    cache_payload = json.dumps({"answer_text": answer_text, "audio_b64": make_beep_wav_b64()})
    r.set(cache_key, cache_payload, ex=CACHE_TTL)
    log(f"turn={turn_id} wrote result to Redis cache (TTL={CACHE_TTL}s)")

    total_ms = (time.perf_counter() - t_start) * 1000
    log(f"turn={turn_id} FULL PIPELINE done in {total_ms:.1f}ms (real Qdrant + real Redis + mocked pipelined LLM/TTS)")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # suppress default HTTP logging, we have our own structured logs

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"accepted")
        threading.Thread(target=process_turn, args=(body,), daemon=True).start()


if __name__ == "__main__":
    port = 5678
    log(f"Mock n8n webhook listening on :{port} (stand-in for real n8n workflow.json)")
    socketserver.ThreadingTCPServer.allow_reuse_address = True  # avoids TIME_WAIT bind failures on quick restarts
    with socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler) as httpd:
        httpd.serve_forever()
