from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.pipeline.adapters import eacl_csv, ijcai_html
from src.pipeline.schema import dataset_summary, validate_dataset

ROOT = Path(__file__).resolve().parents[2]
CONFERENCES_DIR = ROOT / "conferences"


def conference_dir(conference_id: str) -> Path:
    path = CONFERENCES_DIR / conference_id
    if not (path / "conference.json").exists():
        raise FileNotFoundError(f"Unknown conference: {conference_id}")
    return path


def load_profile(conference_id: str) -> dict[str, Any]:
    path = conference_dir(conference_id) / "conference.json"
    return json.loads(path.read_text(encoding="utf-8"))


def conference_ids() -> list[str]:
    return sorted(path.name for path in CONFERENCES_DIR.iterdir() if (path / "conference.json").exists())


def _download(url: str, path: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "conference-paper-navigator/1.0 (+https://github.com/dennis-fast/conference-paper-navigator)"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    print(f"fetched {url} -> {path.relative_to(ROOT)} ({len(payload):,} bytes)")


def fetch(conference_id: str) -> None:
    profile = load_profile(conference_id)
    source = profile["source"]
    if source["adapter"] != "ijcai_html":
        raise ValueError(f"{conference_id} uses a local source and does not support fetch")
    base = conference_dir(conference_id)
    _download(source["url"], base / source["path"])
    for slug in source.get("tracks", {}):
        url = f"{source['url']}?{urllib.parse.urlencode({'ijtrack': slug})}"
        _download(url, base / "raw" / "tracks" / f"{slug}.html")
    metadata = {
        "source_url": source["url"],
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }
    (base / "raw" / "source.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def normalize(conference_id: str) -> dict[str, Any]:
    profile = load_profile(conference_id)
    source = profile["source"]
    base = conference_dir(conference_id)
    source_path = base / source["path"]
    adapter = source["adapter"]
    if adapter == "eacl_csv":
        dataset = eacl_csv.load(source_path, conference_id, source.get("url", ""))
    elif adapter == "ijcai_html":
        dataset = ijcai_html.load(
            source_path,
            conference_id,
            source.get("url", ""),
            tracks=source.get("tracks", {}),
            track_dir=base / "raw" / "tracks",
        )
    else:
        raise ValueError(f"Unsupported adapter: {adapter}")

    source_metadata = base / "raw" / "source.json"
    if source_metadata.exists():
        dataset["source_metadata"] = json.loads(source_metadata.read_text(encoding="utf-8"))
    errors = validate_dataset(dataset)
    if errors:
        raise ValueError("Dataset validation failed:\n- " + "\n- ".join(errors))
    output = base / "data" / "papers.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"normalized {conference_id}: {json.dumps(dataset_summary(dataset), sort_keys=True)}")
    return dataset


def validate(conference_id: str) -> None:
    path = conference_dir(conference_id) / "data" / "papers.json"
    dataset = json.loads(path.read_text(encoding="utf-8"))
    errors = validate_dataset(dataset)
    if errors:
        raise ValueError("Dataset validation failed:\n- " + "\n- ".join(errors))
    print(f"valid {conference_id}: {json.dumps(dataset_summary(dataset), sort_keys=True)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest and validate conference data")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("fetch", "normalize", "validate"):
        sub = subparsers.add_parser(command)
        sub.add_argument("conference", choices=conference_ids())
    args = parser.parse_args()
    if args.command == "fetch":
        fetch(args.conference)
    elif args.command == "normalize":
        normalize(args.conference)
    else:
        validate(args.conference)


if __name__ == "__main__":
    main()
