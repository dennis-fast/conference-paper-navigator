"""Compute SPECTER2 embeddings for one normalized conference dataset."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.analysis.embedding_utils import build_doc, encode_texts, load_specter2_model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("conference")
    parser.add_argument("--base-model", default="allenai/specter2_base")
    parser.add_argument("--adapter-model", default="allenai/specter2")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    base = ROOT / "conferences" / args.conference / "data"
    dataset = json.loads((base / "papers.json").read_text(encoding="utf-8"))
    papers = dataset["papers"]
    tokenizer, model, used_adapter = load_specter2_model(args.base_model, args.adapter_model, allow_fallback=True)
    print(f"SPECTER2 adapter active: {used_adapter}")
    separator = f" {tokenizer.sep_token} " if tokenizer.sep_token else " [SEP] "
    documents = [build_doc(paper["title"], paper.get("abstract", ""), separator) for paper in papers]
    embeddings = encode_texts(
        documents,
        tokenizer,
        model,
        batch_size=args.batch_size,
        device=args.device,
        pooling="cls",
    ).astype(np.float32)
    output = base / "embeddings.npz"
    np.savez_compressed(output, ids=np.array([paper["id"] for paper in papers], dtype=object), embeddings=embeddings)
    print(f"wrote {output.relative_to(ROOT)} with shape {embeddings.shape}")


if __name__ == "__main__":
    main()
