#!/usr/bin/env python3
"""
Precompute embeddings and load a knowledge base into Qdrant.

This is the ONLY place embeddings are ever computed for the corpus -- the live query
path (n8n workflow) only embeds the user's query, never re-embeds documents. This
satisfies the spec's "precomputed embeddings only" RAG constraint.

Usage:
    python ingest.py --source ./docs --collection kb
    python ingest.py --source ./docs --collection kb --recreate   # wipe + rebuild
"""
import argparse
import hashlib
import os
import sys
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from openai import OpenAI
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(__file__))
from chunk import chunk_text  # noqa: E402

EMBEDDING_MODEL = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIM = 1536  # text-embedding-3-small
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")


def read_documents(source_dir: str):
    """Yield (doc_id, text) for every .txt/.md file under source_dir."""
    for path in sorted(Path(source_dir).rglob("*")):
        if path.suffix.lower() in (".txt", ".md"):
            text = path.read_text(encoding="utf-8", errors="ignore")
            yield str(path), text


def stable_point_id(doc_id: str, chunk_idx: int) -> str:
    """Deterministic point ID so re-running ingest on unchanged docs is idempotent
    (upsert overwrites the same point instead of duplicating)."""
    raw = f"{doc_id}::{chunk_idx}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def embed_batch(client: OpenAI, texts: list[str]) -> list[list[float]]:
    resp = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Directory of .txt/.md docs")
    parser.add_argument("--collection", default=os.environ.get("QDRANT_COLLECTION", "kb"))
    parser.add_argument("--recreate", action="store_true", help="Drop and recreate the collection")
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    openai_client = OpenAI()
    qdrant = QdrantClient(url=QDRANT_URL)

    if args.recreate or not qdrant.collection_exists(args.collection):
        qdrant.recreate_collection(
            collection_name=args.collection,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        print(f"Created collection '{args.collection}'")

    all_chunks = []  # (point_id, text, payload)
    for doc_id, text in read_documents(args.source):
        for i, c in enumerate(chunk_text(text)):
            if not (200 <= c.token_count <= 550):  # tolerant band around 300-500 target
                print(f"WARNING: chunk {i} of {doc_id} has {c.token_count} tokens "
                      f"(outside 300-500 target band)", file=sys.stderr)
            all_chunks.append((
                stable_point_id(doc_id, i),
                c.text,
                {"doc_id": doc_id, "chunk_idx": i, "token_count": c.token_count, "text": c.text},
            ))

    if not all_chunks:
        print(f"No .txt/.md documents found under {args.source}")
        return

    print(f"Embedding {len(all_chunks)} chunks from source '{args.source}'...")
    for i in tqdm(range(0, len(all_chunks), args.batch_size)):
        batch = all_chunks[i:i + args.batch_size]
        vectors = embed_batch(openai_client, [b[1] for b in batch])
        points = [
            PointStruct(id=pid, vector=vec, payload=payload)
            for (pid, _, payload), vec in zip(batch, vectors)
        ]
        qdrant.upsert(collection_name=args.collection, points=points)

    count = qdrant.count(args.collection).count
    print(f"Done. Collection '{args.collection}' now has {count} points.")


if __name__ == "__main__":
    main()
