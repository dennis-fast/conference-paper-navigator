from __future__ import annotations

from collections import Counter
from typing import Any

SCHEMA_VERSION = 1
PRESENTATION_TYPES = {"oral", "poster", "demo", "other"}


def text(value: Any) -> str:
    if value is None:
        return ""
    result = str(value).strip()
    return "" if result.lower() == "nan" else result


def make_presentation(
    presentation_type: str,
    *,
    session: Any = "",
    date: Any = "",
    time: Any = "",
    location: Any = "",
    order: Any = "",
    attendance_type: Any = "",
) -> dict[str, str]:
    kind = text(presentation_type).lower() or "other"
    if kind not in PRESENTATION_TYPES:
        kind = "other"
    return {
        "type": kind,
        "session": text(session),
        "date": text(date),
        "time": text(time),
        "location": text(location),
        "order": text(order),
        "attendance_type": text(attendance_type),
    }


def presentation_key(item: dict[str, Any]) -> tuple[str, ...]:
    return tuple(text(item.get(key)) for key in ("type", "session", "date", "time", "location", "order"))


def validate_dataset(dataset: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if dataset.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if not text(dataset.get("conference_id")):
        errors.append("conference_id is required")

    papers = dataset.get("papers")
    if not isinstance(papers, list):
        return errors + ["papers must be a list"]

    ids: list[str] = []
    for index, paper in enumerate(papers):
        if not isinstance(paper, dict):
            errors.append(f"papers[{index}] must be an object")
            continue
        paper_id = text(paper.get("id"))
        if not paper_id:
            errors.append(f"papers[{index}].id is required")
        else:
            ids.append(paper_id)
        if not text(paper.get("title")):
            errors.append(f"paper {paper_id or index} has no title")
        presentations = paper.get("presentations", [])
        if not isinstance(presentations, list):
            errors.append(f"paper {paper_id or index} presentations must be a list")
            continue
        for presentation in presentations:
            if text(presentation.get("type")) not in PRESENTATION_TYPES:
                errors.append(f"paper {paper_id or index} has an invalid presentation type")

    duplicates = sorted(paper_id for paper_id, count in Counter(ids).items() if count > 1)
    if duplicates:
        errors.append(f"duplicate paper IDs: {', '.join(duplicates[:10])}")
    return errors


def dataset_summary(dataset: dict[str, Any]) -> dict[str, int]:
    papers = dataset.get("papers", [])
    counts = Counter(
        presentation.get("type", "other")
        for paper in papers
        for presentation in paper.get("presentations", [])
    )
    return {
        "papers": len(papers),
        "oral_presentations": counts["oral"],
        "poster_presentations": counts["poster"],
        "demo_presentations": counts["demo"],
        "missing_abstracts": sum(not text(paper.get("abstract")) for paper in papers),
    }
