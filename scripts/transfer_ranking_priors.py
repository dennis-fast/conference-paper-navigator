#!/usr/bin/env python3
"""Transfer learned paper preferences between conferences using embeddings."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.neighbors import KNeighborsRegressor

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis.embedding_utils import l2_normalize, load_embeddings


DEFAULT_MU = 1500.0
DEFAULT_SIGMA = 350.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_state", type=Path, help="Source ranking state or Navigator backup")
    parser.add_argument("source_embeddings", type=Path)
    parser.add_argument("target_embeddings", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--conference-id", required=True)
    parser.add_argument("--conference-name", required=True)
    parser.add_argument("--ridge-alpha", type=float, default=0.1)
    parser.add_argument("--ridge-weight", type=float, default=0.4)
    parser.add_argument("--neighbors", type=int, default=20)
    parser.add_argument("--prior-sigma", type=float, default=DEFAULT_SIGMA)
    return parser.parse_args()


def ranking_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Source state must be a JSON object")
    if value.get("type") == "conference-paper-navigator-state":
        value = value.get("state")
    if not isinstance(value, dict) or not isinstance(value.get("ratings"), dict):
        raise ValueError("Source JSON has no ratings object")
    return value


def main() -> None:
    args = parse_args()
    if not 0 <= args.ridge_weight <= 1:
        raise ValueError("--ridge-weight must be between 0 and 1")
    if args.neighbors < 1:
        raise ValueError("--neighbors must be positive")
    if args.prior_sigma <= 0:
        raise ValueError("--prior-sigma must be positive")

    source = ranking_state(json.loads(args.source_state.read_text(encoding="utf-8")))
    source_ids, source_vectors = load_embeddings(args.source_embeddings)
    target_ids, target_vectors = load_embeddings(args.target_embeddings)
    source_vectors = l2_normalize(source_vectors)
    target_vectors = l2_normalize(target_vectors)

    rows = [index for index, paper_id in enumerate(source_ids) if paper_id in source["ratings"]]
    if len(rows) < max(20, args.neighbors):
        raise ValueError(f"Only {len(rows)} source ratings have matching embeddings")
    train_ids = source_ids[rows]
    train_vectors = source_vectors[rows]
    targets = np.array([float(source["ratings"][paper_id]["mu"]) for paper_id in train_ids])

    ridge = Ridge(alpha=args.ridge_alpha).fit(train_vectors, targets)
    neighbors = KNeighborsRegressor(
        n_neighbors=args.neighbors,
        weights="distance",
        metric="cosine",
    ).fit(train_vectors, targets)
    ridge_prediction = ridge.predict(target_vectors)
    neighbor_prediction = neighbors.predict(target_vectors)
    prediction = args.ridge_weight * ridge_prediction + (1 - args.ridge_weight) * neighbor_prediction
    prediction += DEFAULT_MU - float(prediction.mean())

    priors = {
        str(paper_id): {"mu": float(score), "sigma": float(args.prior_sigma)}
        for paper_id, score in zip(target_ids, prediction, strict=True)
    }
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    state = {
        "schema_version": 1,
        "conference_id": args.conference_id,
        "priors": priors,
        "ratings": {},
        "history": [],
        "history_tombstones": [],
        "reset_at": "",
        "modified_at": now,
        "lastPair": [],
        "mode": "active",
        "topN": 60,
        "resolveTieNMatches": "minimal",
        "muPriority": "highest",
        "winsOnly": False,
        "scheduleByPresentationOrder": False,
    }
    backup = {
        "type": "conference-paper-navigator-state",
        "export_version": 1,
        "exported_at": now,
        "conference": {"id": args.conference_id, "name": args.conference_name},
        "summary": {"comparisons": 0, "rated_papers": 0, "prior_papers": len(priors)},
        "transfer": {
            "source_state": args.source_state.name,
            "source_ratings_with_embeddings": len(train_ids),
            "method": (
                f"{args.ridge_weight:g} ridge regression + "
                f"{1 - args.ridge_weight:g} distance-weighted {args.neighbors}-nearest-neighbor regression"
            ),
            "embedding_space": "SPECTER2",
            "prior_mean": float(prediction.mean()),
            "prior_standard_deviation": float(prediction.std()),
            "note": "Predictions are uncertain priors, not completed paper reviews.",
        },
        "state": state,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(backup, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {args.output}: {len(priors)} priors from {len(train_ids)} source ratings; "
        f"mu range {prediction.min():.2f}–{prediction.max():.2f}"
    )


if __name__ == "__main__":
    main()
