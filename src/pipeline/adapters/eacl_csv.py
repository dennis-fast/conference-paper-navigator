from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from src.pipeline.schema import SCHEMA_VERSION, make_presentation, presentation_key, text


def _authors(value: Any) -> list[str]:
    raw = text(value)
    delimiter = ";" if ";" in raw else ","
    return [part.strip() for part in raw.split(delimiter) if part.strip()]


def _merge_text(current: str, candidate: Any) -> str:
    return current or text(candidate)


def load(path: Path, conference_id: str, source_url: str = "") -> dict[str, Any]:
    papers_by_id: dict[str, dict[str, Any]] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = csv.DictReader(handle)
        for row in rows:
            paper_id = text(row.get("Paper number") or row.get("paper_id") or row.get("id"))
            if not paper_id:
                continue
            paper = papers_by_id.setdefault(
                paper_id,
                {
                    "id": paper_id,
                    "title": "",
                    "abstract": "",
                    "authors": [],
                    "presenter": "",
                    "track": "",
                    "primary_category": "",
                    "secondary_category": "",
                    "keywords": [],
                    "source_url": source_url,
                    "presentations": [],
                },
            )
            paper["title"] = _merge_text(paper["title"], row.get("Title"))
            paper["abstract"] = _merge_text(paper["abstract"], row.get("Abstract"))
            paper["authors"] = paper["authors"] or _authors(row.get("Authors Names"))
            paper["presenter"] = _merge_text(paper["presenter"], row.get("Presenters Name"))
            paper["primary_category"] = _merge_text(paper["primary_category"], row.get("category_primary"))
            paper["secondary_category"] = _merge_text(paper["secondary_category"], row.get("category_secondary"))
            if not paper["keywords"]:
                paper["keywords"] = [part.strip() for part in text(row.get("keywords")).split(";") if part.strip()]

            raw_type = text(row.get("Type of Presentation")).lower()
            location = text(row.get("Room Location"))
            if "oral" in raw_type:
                kind = "oral"
            elif "demo" in raw_type:
                kind = "demo"
            elif "poster" in raw_type or "poster hall" in location.lower():
                kind = "poster"
            else:
                kind = "other"
            presentation = make_presentation(
                kind,
                session=row.get("Session"),
                date=row.get("Session Date"),
                time=row.get("Session time"),
                location=location,
                order=row.get("Order"),
                attendance_type=row.get("Attendance Type"),
            )
            existing = {presentation_key(item) for item in paper["presentations"]}
            if presentation_key(presentation) not in existing:
                paper["presentations"].append(presentation)

    return {
        "schema_version": SCHEMA_VERSION,
        "conference_id": conference_id,
        "source_url": source_url,
        "papers": list(papers_by_id.values()),
    }
