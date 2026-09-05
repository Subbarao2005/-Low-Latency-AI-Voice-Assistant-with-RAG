#!/usr/bin/env python3
"""
LIVE DEMO variant of ingest.py.

Identical chunking logic to the real ingest.py (imports the same chunk_text function),
but swaps OpenAI embeddings for a local deterministic hashing-based embedder so this can
run without network access / API keys. This is ONLY for proving the Qdrant upsert+search
plumbing works -- swap `embed()` for the real OpenAI call in production (see ingest.py).
"""
import hashlib
import os
import sys

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

sys.path.insert(0, os.path.dirname(__file__))
from chunk import chunk_text  # noqa: E402

DIM = 256


def embed(text: str) -> list[float]:
    """Deterministic hashing-based bag-of-words embedding (NOT semantically strong like
    a real transformer embedding -- stand-in only, so identical/overlapping vocabulary
    clusters together, which is enough to prove retrieval plumbing works end-to-end)."""
    vec = [0.0] * DIM
    words = text.lower().split()
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        idx = h % DIM
        sign = 1.0 if (h // DIM) % 2 == 0 else -1.0
        vec[idx] += sign
    norm = sum(v * v for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


def main():
    client = QdrantClient(path="/home/claude/qdrant_local_data")
    collection = "kb_demo"

    if client.collection_exists(collection):
        client.delete_collection(collection)
    client.create_collection(
        collection_name=collection,
        vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
    )
    print(f"Created collection '{collection}' (dim={DIM}, cosine distance)")

    import pathlib
    all_points = []
    for path in sorted(pathlib.Path("/home/claude/demo_docs").glob("*.md")):
        text = path.read_text()
        chunks = chunk_text(text)
        print(f"\n{path.name}: {len(text.split())} words -> {len(chunks)} chunk(s)")
        for i, c in enumerate(chunks):
            print(f"  chunk {i}: {c.token_count} tokens (target band 300-500) -- "
                  f"{'OK' if c.token_count <= 550 else 'OUT OF BAND'}")
            point_id = int(hashlib.sha256(f"{path.name}::{i}".encode()).hexdigest()[:8], 16)
            all_points.append(PointStruct(
                id=point_id,
                vector=embed(c.text),
                payload={"doc_id": path.name, "chunk_idx": i, "text": c.text, "token_count": c.token_count},
            ))

    client.upsert(collection_name=collection, points=all_points)
    count = client.count(collection).count
    print(f"\nUpserted {len(all_points)} points. Collection now has {count} points total.")


if __name__ == "__main__":
    main()
