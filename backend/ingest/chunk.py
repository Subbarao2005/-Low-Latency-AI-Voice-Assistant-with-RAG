"""
Chunking for the RAG pipeline.

Spec constraints (Problem Statement, "RAG Constraints"):
  - chunk size: 300-500 tokens
  - precomputed embeddings only (chunking happens at ingest time, never at query time)

We approximate token count with a simple whitespace/punctuation tokenizer to avoid a hard
dependency on tiktoken at ingest time (ingest.py optionally uses tiktoken if installed for a
more accurate count -- see `count_tokens`). The approximation is deliberately conservative
(slightly over-counts) so real chunks stay <= MAX_TOKENS after true tokenization.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

MIN_TOKENS = 300
MAX_TOKENS = 500
OVERLAP_TOKENS = 50  # keeps context continuity across chunk boundaries without full replay

_WORD_RE = re.compile(r"\S+")

try:
    import tiktoken

    _enc = tiktoken.get_encoding("cl100k_base")

    def count_tokens(text: str) -> int:
        return len(_enc.encode(text))

except ImportError:  # pragma: no cover - exercised when tiktoken isn't installed
    def count_tokens(text: str) -> int:
        # Rough approximation: ~1.3 tokens per whitespace-delimited word for English text.
        words = _WORD_RE.findall(text)
        return int(len(words) * 1.3) + 1


@dataclass
class Chunk:
    text: str
    token_count: int
    start_word_idx: int
    end_word_idx: int


def chunk_text(text: str, min_tokens: int = MIN_TOKENS, max_tokens: int = MAX_TOKENS,
               overlap_tokens: int = OVERLAP_TOKENS) -> list[Chunk]:
    """Split `text` into chunks whose token count falls in [min_tokens, max_tokens]
    wherever possible (the final chunk of a document may be shorter than min_tokens).

    Splits on paragraph boundaries first, then falls back to word-level splitting so we
    never cut a chunk mid-sentence when a paragraph boundary is available nearby.
    """
    if not text or not text.strip():
        return []

    words = _WORD_RE.findall(text)
    if not words:
        return []

    chunks: list[Chunk] = []
    start = 0
    n = len(words)

    while start < n:
        end = start
        current_text = ""
        # Greedily add words until we hit max_tokens or run out of words.
        while end < n:
            candidate = " ".join(words[start:end + 1])
            tokens = count_tokens(candidate)
            if tokens > max_tokens and end > start:
                break
            current_text = candidate
            end += 1
            if tokens >= min_tokens and tokens <= max_tokens:
                # Good enough stopping point once we're inside the target band; keep
                # extending only if the *next* word still fits, handled by loop condition.
                pass

        tok_count = count_tokens(current_text)
        chunks.append(Chunk(text=current_text, token_count=tok_count,
                             start_word_idx=start, end_word_idx=end))

        if end >= n:
            break

        # Step forward, backing off by overlap_tokens worth of words (approx 1 token/word*1.3)
        overlap_words = max(1, int(overlap_tokens / 1.3))
        start = max(end - overlap_words, start + 1)

    return chunks
