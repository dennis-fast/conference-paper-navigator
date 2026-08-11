#!/usr/bin/env python3
"""Convert an original preference-arena state into a Navigator backup."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CHOICES = {"A", "STRONG_A", "B", "STRONG_B", "BOTH", "NEITHER", "SKIP"}
RATING_DEFAULTS = {
    "mu": 1500.0,
    "sigma": 350.0,
    "n": 0,
    "wins": 0,
    "losses": 0,
    "ties": 0,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Legacy preference state JSON")
    parser.add_argument("output", type=Path, help="Navigator backup JSON to create")
    parser.add_argument("--conference-id", required=True)
    parser.add_argument("--conference-name", required=True)
    parser.add_argument(
        "--papers",
        type=Path,
        help="Optional current papers.json used to report identifier coverage",
    )
    return parser.parse_args()


def normalize_rating(paper_id: str, raw: Any) -> dict[str, float | int]:
    if not isinstance(raw, dict):
        raise ValueError(f"Rating for {paper_id!r} is not an object")
    rating: dict[str, float | int] = {}
    for field, default in RATING_DEFAULTS.items():
        value = raw.get(field, default)
        if field in {"n", "wins", "losses", "ties"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or value < 0:
                raise ValueError(f"Invalid {field} for paper {paper_id!r}")
            rating[field] = int(value)
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"Invalid {field} for paper {paper_id!r}")
            rating[field] = float(value)
    if rating["sigma"] <= 0:
        raise ValueError(f"Invalid sigma for paper {paper_id!r}")
    return rating


def normalize_history(raw_history: Any, conference_id: str) -> list[dict[str, Any]]:
    if not isinstance(raw_history, list):
        raise ValueError("Legacy history is not an array")
    history: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_history, start=1):
        if not isinstance(raw, dict) or not raw.get("a") or not raw.get("b"):
            raise ValueError(f"Comparison {index} is invalid")
        outcome = raw.get("outcome")
        if outcome is not None:
            if isinstance(outcome, bool) or not isinstance(outcome, (int, float)) or not 0 <= outcome <= 1:
                raise ValueError(f"Comparison {index} has an invalid outcome")
            outcome = float(outcome)
        choice = raw.get("choice")
        if choice not in CHOICES:
            raise ValueError(f"Comparison {index} has an invalid choice")
        multiplier = raw.get("kMult")
        if isinstance(multiplier, bool) or not isinstance(multiplier, (int, float)) or multiplier < 0:
            raise ValueError(f"Comparison {index} has an invalid kMult")
        history.append(
            {
                "id": f"legacy-{conference_id}-{index:06d}",
                "a": str(raw["a"]),
                "b": str(raw["b"]),
                "outcome": outcome,
                "choice": choice,
                "kMult": float(multiplier),
                "ts": str(raw.get("ts") or ""),
            }
        )
    return history


def current_paper_ids(path: Path | None) -> set[str] | None:
    if path is None:
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("papers"), list):
        raise ValueError(f"{path} is not a Navigator papers dataset")
    return {str(paper["id"]) for paper in value["papers"]}


def main() -> None:
    args = parse_args()
    legacy = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(legacy, dict) or not isinstance(legacy.get("ratings"), dict):
        raise ValueError("Input is not a legacy preference state")

    ratings = {
        str(paper_id): normalize_rating(str(paper_id), rating)
        for paper_id, rating in legacy["ratings"].items()
    }
    history = normalize_history(legacy.get("history", []), args.conference_id)
    ids = current_paper_ids(args.papers)
    history_ids = {entry[side] for entry in history for side in ("a", "b")}
    missing_ids = sorted(history_ids - ids) if ids is not None else []

    last_pair = []
    for paper in legacy.get("lastPair", [])[:2]:
        paper_id = paper.get("id") if isinstance(paper, dict) else paper
        if paper_id is not None:
            last_pair.append({"id": str(paper_id)})

    timestamps = [entry["ts"] for entry in history if entry["ts"]]
    modified_at = max(timestamps, default="")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    state = {
        "schema_version": 1,
        "conference_id": args.conference_id,
        "ratings": ratings,
        "history": history,
        "history_tombstones": [],
        "reset_at": "",
        "modified_at": modified_at,
        "lastPair": last_pair,
        "mode": legacy.get("mode", "active"),
        "topN": legacy.get("topN", 60),
        "resolveTieNMatches": legacy.get("resolveTieNMatches", "minimal"),
        "muPriority": legacy.get("muPriority", "highest"),
        "winsOnly": bool(legacy.get("winsOnly", False)),
        "scheduleByPresentationOrder": bool(legacy.get("scheduleByPresentationOrder", False)),
    }
    backup = {
        "type": "conference-paper-navigator-state",
        "export_version": 1,
        "exported_at": now,
        "conference": {"id": args.conference_id, "name": args.conference_name},
        "summary": {
            "comparisons": len(history),
            "rated_papers": sum(int(rating["n"]) > 0 for rating in ratings.values()),
        },
        "migration": {
            "source_format": f"legacy-preference-arena-v{legacy.get('version', 'unknown')}",
            "source_file": args.input.name,
            "current_dataset_papers": len(ids) if ids is not None else None,
            "legacy_paper_ids_not_in_current_dataset": missing_ids,
            "note": "Legacy-only comparison participants are retained so replay preserves scores for current papers.",
        },
        "state": state,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(backup, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {args.output}: {len(history)} comparisons, {len(ratings)} rated papers, "
        f"{len(missing_ids)} legacy-only paper IDs"
    )


if __name__ == "__main__":
    main()
