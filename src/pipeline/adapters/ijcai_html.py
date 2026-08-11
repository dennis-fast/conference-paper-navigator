from __future__ import annotations

from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from src.pipeline.schema import SCHEMA_VERSION, make_presentation, text


def _schedule(value: str) -> tuple[str, str, str]:
    parts = [part.strip() for part in value.split("·")]
    return (
        parts[0] if parts else "",
        parts[1] if len(parts) > 1 else "",
        parts[2] if len(parts) > 2 else "",
    )


def _track_membership(track_dir: Path, tracks: dict[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for slug, label in tracks.items():
        path = track_dir / f"{slug}.html"
        if not path.exists():
            continue
        soup = BeautifulSoup(path.read_text(encoding="utf-8"), "lxml")
        for item in soup.select("li.ij-paper"):
            pid = item.select_one(".ij-pid")
            if pid:
                result[text(pid.get_text()).lstrip("#")] = label
    return result


def load(
    path: Path,
    conference_id: str,
    source_url: str,
    *,
    tracks: dict[str, str] | None = None,
    track_dir: Path | None = None,
) -> dict[str, Any]:
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "lxml")
    track_by_id = _track_membership(track_dir, tracks or {}) if track_dir else {}
    papers: list[dict[str, Any]] = []

    for item in soup.select("li.ij-paper"):
        pid_node = item.select_one(".ij-pid")
        title_node = item.select_one(".ij-ptitle")
        if not pid_node or not title_node:
            continue
        paper_id = text(pid_node.get_text()).lstrip("#")
        authors = [text(node.get_text(" ", strip=True)) for node in item.select(".ij-author")]
        abstract_node = item.select_one(".ij-abstract")
        presentations: list[dict[str, str]] = []

        oral_node = item.select_one(".ij-when--talk")
        if oral_node:
            date, time, room = _schedule(oral_node.get_text(" ", strip=True))
            presentations.append(
                make_presentation("oral", date=date, time=time, location=room, attendance_type="In-person")
            )
        poster_node = item.select_one(".ij-when--poster")
        if poster_node:
            date, time, location = _schedule(poster_node.get_text(" ", strip=True))
            presentations.append(
                make_presentation(
                    "poster",
                    date=date,
                    time=time,
                    location=location or "Poster area",
                    attendance_type="In-person",
                )
            )

        topics: list[dict[str, str]] = []
        for keyword in item.select(".ij-kw"):
            area_node = keyword.select_one(".ij-kw-area")
            area = text(area_node.get_text(" ", strip=True) if area_node else "")
            label = text(keyword.get("title"))
            if "→" in label:
                _, label = [part.strip() for part in label.split("→", 1)]
            elif area:
                label = text(keyword.get_text(" ", strip=True)).removeprefix(area).strip(" ·")
            topics.append({"area": area, "label": label})

        source_link = item.select_one(".ij-oslink a")
        papers.append(
            {
                "id": paper_id,
                "title": text(title_node.get_text(" ", strip=True)),
                "abstract": text(abstract_node.get_text(" ", strip=True) if abstract_node else ""),
                "authors": authors,
                "presenter": "",
                "track": track_by_id.get(paper_id, ""),
                "primary_category": topics[0]["area"] if topics else "",
                "secondary_category": topics[0]["label"] if topics else "",
                "keywords": [topic["label"] for topic in topics if topic["label"]],
                "topics": topics,
                "source_url": source_link.get("href") if source_link else source_url,
                "presentations": presentations,
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "conference_id": conference_id,
        "source_url": source_url,
        "papers": papers,
    }
