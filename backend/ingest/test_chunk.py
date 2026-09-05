import pytest
from chunk import chunk_text, count_tokens, MIN_TOKENS, MAX_TOKENS


def make_text(num_words: int) -> str:
    return " ".join(f"word{i}" for i in range(num_words))


def test_empty_text_returns_no_chunks():
    assert chunk_text("") == []
    assert chunk_text("   \n  ") == []


def test_short_text_single_chunk_below_min_is_allowed():
    # A short doc shorter than MIN_TOKENS should still produce one (final) chunk,
    # never be dropped.
    text = make_text(20)
    chunks = chunk_text(text)
    assert len(chunks) == 1
    assert chunks[0].token_count <= MAX_TOKENS


def test_long_text_chunks_stay_within_token_band():
    # ~3000 words is comfortably several chunks worth.
    text = make_text(3000)
    chunks = chunk_text(text)
    assert len(chunks) > 1
    for c in chunks[:-1]:  # all but the last chunk should hit the target band
        assert c.token_count <= MAX_TOKENS, f"chunk exceeded MAX_TOKENS: {c.token_count}"
        assert c.token_count >= MIN_TOKENS * 0.8, f"chunk far below MIN_TOKENS: {c.token_count}"
    # last chunk may be shorter, but never over the max
    assert chunks[-1].token_count <= MAX_TOKENS


def test_no_chunk_ever_exceeds_max_tokens():
    text = make_text(5000)
    chunks = chunk_text(text)
    for c in chunks:
        assert c.token_count <= MAX_TOKENS


def test_chunks_have_overlap_for_context_continuity():
    text = make_text(1200)
    chunks = chunk_text(text)
    assert len(chunks) >= 2
    # consecutive chunks should share at least one word (overlap), except possibly the
    # very last boundary if the document ended exactly on a chunk edge.
    overlapping_pairs = 0
    for a, b in zip(chunks, chunks[1:]):
        if b.start_word_idx < a.end_word_idx:
            overlapping_pairs += 1
    assert overlapping_pairs > 0


def test_full_document_is_covered_no_gaps():
    text = make_text(1500)
    words = text.split()
    chunks = chunk_text(text)
    covered = set()
    for c in chunks:
        for i in range(c.start_word_idx, c.end_word_idx):
            covered.add(i)
    assert covered == set(range(len(words))), "some words were dropped between chunks"


def test_count_tokens_scales_with_length():
    short = count_tokens(make_text(10))
    long = count_tokens(make_text(1000))
    assert long > short


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
