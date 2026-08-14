from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import normalize

try:
    import umap
except Exception:
    umap = None

ROOT = Path(__file__).resolve().parents[2]
CONFERENCES_DIR = ROOT / "conferences"
DOCS_DIR = ROOT / "docs"
WEB_DIR = ROOT / "src" / "web"
PREFERENCE_DIMENSIONS = 48


def conference_ids() -> list[str]:
    return sorted(path.name for path in CONFERENCES_DIR.iterdir() if (path / "conference.json").exists())


def _presentation(paper: dict[str, Any], kind: str) -> dict[str, str]:
    return next((item for item in paper.get("presentations", []) if item.get("type") == kind), {})


def _field(paper: dict[str, Any], field: str) -> str:
    if field == "oral_room":
        return str(_presentation(paper, "oral").get("location", ""))
    if field == "oral_session":
        return str(_presentation(paper, "oral").get("session", ""))
    return str(paper.get(field, ""))


def build_projection(profile: dict[str, Any], dataset: dict[str, Any], embeddings_path: Path) -> dict[str, Any]:
    npz = np.load(embeddings_path, allow_pickle=True)
    ids = [str(value.decode("utf-8") if isinstance(value, bytes) else value) for value in np.asarray(npz["ids"]).reshape(-1)]
    embeddings = np.asarray(npz["embeddings"])
    embedding_index = {paper_id: index for index, paper_id in enumerate(ids)}
    papers = [paper for paper in dataset["papers"] if str(paper["id"]) in embedding_index]
    if len(papers) < 3:
        raise ValueError(f"{profile['id']} needs at least three embedded papers")
    vectors = normalize(np.asarray([embeddings[embedding_index[str(paper["id"])]] for paper in papers]), norm="l2")
    pca_xy = PCA(n_components=2, random_state=42).fit_transform(vectors)
    pre_components = max(2, min(50, vectors.shape[0] - 1, vectors.shape[1]))
    nonlinear = PCA(n_components=pre_components, random_state=42).fit_transform(vectors) if vectors.shape[1] > pre_components else vectors
    tsne_xy = TSNE(
        n_components=2,
        perplexity=min(30.0, float(len(papers) - 1)),
        learning_rate="auto",
        init="pca",
        metric="cosine",
        random_state=42,
        max_iter=1000,
    ).fit_transform(nonlinear)
    if umap is not None:
        try:
            umap_xy = umap.UMAP(n_components=2, n_neighbors=15, min_dist=0.1, metric="cosine", random_state=42).fit_transform(nonlinear)
        except Exception:
            umap_xy = pca_xy.copy()
    else:
        umap_xy = pca_xy.copy()

    group_field = profile.get("projection", {}).get("group_field", "track")
    location_field = profile.get("projection", {}).get("location_field", "oral_room")
    metadata: list[dict[str, str]] = []
    for paper in papers:
        types = sorted({item.get("type", "") for item in paper.get("presentations", []) if item.get("type")})
        attendance = sorted({item.get("attendance_type", "") for item in paper.get("presentations", []) if item.get("attendance_type")})
        metadata.append(
            {
                "paper_id": str(paper["id"]),
                "title": str(paper["title"]),
                "session": _field(paper, group_field),
                "room_location": _field(paper, location_field),
                "type_presentation": ", ".join(types),
                "attendance_type": ", ".join(attendance),
            }
        )

    def coordinates(values: np.ndarray) -> list[dict[str, str | float]]:
        return [
            {"paper_id": str(paper["id"]), "x": float(values[index, 0]), "y": float(values[index, 1])}
            for index, paper in enumerate(papers)
        ]

    cosine = vectors @ vectors.T
    neighbors: dict[str, list[dict[str, str | float]]] = {}
    for index, paper in enumerate(papers):
        rows: list[dict[str, str | float]] = []
        for neighbor_index in np.argsort(-cosine[index]):
            if neighbor_index == index:
                continue
            item = metadata[int(neighbor_index)]
            rows.append({**item, "cosine": float(cosine[index, neighbor_index])})
            if len(rows) >= min(80, len(papers) - 1):
                break
        neighbors[str(paper["id"])] = rows

    methods = {"pca": coordinates(pca_xy), "tsne": coordinates(tsne_xy), "umap": coordinates(umap_xy)}
    groups = sorted({item["session"] for item in metadata if item["session"]})
    rooms = sorted({item["room_location"] for item in metadata if item["room_location"]})
    types = sorted({item["type_presentation"] for item in metadata if item["type_presentation"]})
    attendance = sorted({item["attendance_type"] for item in metadata if item["attendance_type"]})
    points = [{**item, **methods["pca"][index]} for index, item in enumerate(metadata)]
    return {
        "version": 3,
        "conference_id": profile["id"],
        "method": "pca",
        "n_points": len(points),
        "points": points,
        "points_meta": metadata,
        "methods": methods,
        "neighbors": neighbors,
        "default_columns": {"title": "title", "paper_id": "paper_id", "color_by_all": "Session", "color_by_session": "Room Location"},
        "filters": {"Type of Presentation": types, "Attendance Type": attendance, "Room Location": rooms, "Session": groups},
        "available_sessions": groups,
        "sessions": groups,
        "rooms": rooms,
    }


def build_preference_features(profile: dict[str, Any], dataset: dict[str, Any], embeddings_path: Path) -> dict[str, Any]:
    """Create a compact, deterministic browser-side feature bundle.

    The two-dimensional projection is intentionally not reused for preference
    learning: it discards too much semantic structure.  PCA keeps the browser
    payload small while retaining enough of the normalized SPECTER2 space for a
    lightweight online linear model.
    """
    npz = np.load(embeddings_path, allow_pickle=True)
    ids = [str(value.decode("utf-8") if isinstance(value, bytes) else value) for value in np.asarray(npz["ids"]).reshape(-1)]
    embeddings = np.asarray(npz["embeddings"], dtype=np.float64)
    embedding_index = {paper_id: index for index, paper_id in enumerate(ids)}
    paper_ids = [str(paper["id"]) for paper in dataset["papers"] if str(paper["id"]) in embedding_index]
    vectors = normalize(np.asarray([embeddings[embedding_index[paper_id]] for paper_id in paper_ids]), norm="l2")

    dimensions = max(2, min(PREFERENCE_DIMENSIONS, vectors.shape[0] - 1, vectors.shape[1]))
    reducer = PCA(n_components=dimensions, random_state=42)
    reduced = reducer.fit_transform(vectors)
    reduced = normalize(reduced, norm="l2")

    cluster_count = max(8, min(28, round(len(paper_ids) ** 0.5)))
    clustering = KMeans(n_clusters=cluster_count, random_state=42, n_init=10).fit(reduced)
    representatives: list[str] = []
    for cluster in range(cluster_count):
        member_indices = np.flatnonzero(clustering.labels_ == cluster)
        distances = np.linalg.norm(reduced[member_indices] - clustering.cluster_centers_[cluster], axis=1)
        representatives.append(paper_ids[int(member_indices[int(np.argmin(distances))])])

    return {
        "version": 1,
        "conference_id": profile["id"],
        "source": "l2-normalized SPECTER2 embeddings reduced with PCA",
        "dimensions": dimensions,
        "explained_variance": float(np.sum(reducer.explained_variance_ratio_)),
        "cluster_count": cluster_count,
        "ids": paper_ids,
        "clusters": [int(value) for value in clustering.labels_],
        "representatives": representatives,
        "features": np.round(reduced, 6).tolist(),
    }


def _copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def build_conference(
    conference_id: str,
    *,
    cached_projection: bytes | None = None,
    cached_preference: bytes | None = None,
    rebuild_projection: bool = False,
    rebuild_preference: bool = False,
) -> None:
    base = CONFERENCES_DIR / conference_id
    profile = json.loads((base / "conference.json").read_text(encoding="utf-8"))
    dataset = json.loads((base / "data" / "papers.json").read_text(encoding="utf-8"))
    destination = DOCS_DIR / conference_id
    for source, target in [
        (WEB_DIR / "app" / "index.html", destination / "index.html"),
        (WEB_DIR / "app" / "app.js", destination / "assets" / "js" / "app.js"),
        (WEB_DIR / "app" / "cloud-sync.js", destination / "assets" / "js" / "cloud-sync.js"),
        (WEB_DIR / "app" / "merge-comparisons.js", destination / "assets" / "js" / "merge-comparisons.js"),
        (WEB_DIR / "app" / "sync-fingerprint.js", destination / "assets" / "js" / "sync-fingerprint.js"),
        (WEB_DIR / "app" / "styles.css", destination / "assets" / "css" / "styles.css"),
        (WEB_DIR / "shared" / "rating.js", destination / "assets" / "js" / "rating.js"),
        (WEB_DIR / "shared" / "selector.js", destination / "assets" / "js" / "selector.js"),
        (WEB_DIR / "shared" / "preference-model.js", destination / "assets" / "js" / "preference-model.js"),
        (WEB_DIR / "shared" / "csv.js", destination / "assets" / "js" / "csv.js"),
        (WEB_DIR / "viz" / "index.html", destination / "viz" / "index.html"),
        (WEB_DIR / "viz" / "app.js", destination / "viz" / "app.js"),
        (WEB_DIR / "viz" / "styles.css", destination / "viz" / "styles.css"),
        (base / "conference.json", destination / "data" / "conference.json"),
        (base / "data" / "papers.json", destination / "data" / "papers.json"),
    ]:
        _copy(source, target)
    projection_path = destination / "data" / "projection.json"
    if cached_projection is not None and not rebuild_projection:
        projection_path.parent.mkdir(parents=True, exist_ok=True)
        projection_path.write_bytes(cached_projection)
        projection = json.loads(cached_projection)
    else:
        projection = build_projection(profile, dataset, base / "data" / "embeddings.npz")
        projection_path.write_text(json.dumps(projection, ensure_ascii=False), encoding="utf-8")
    preference_path = destination / "data" / "preference-features.json"
    if cached_preference is not None and not rebuild_preference:
        preference_path.write_bytes(cached_preference)
        preference = json.loads(cached_preference)
    else:
        preference = build_preference_features(profile, dataset, base / "data" / "embeddings.npz")
        preference_path.write_text(json.dumps(preference, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"built {conference_id}: {len(dataset['papers'])} papers, {projection['n_points']} projected, "
        f"{preference['dimensions']} preference dimensions"
    )


def build_landing(ids: list[str]) -> None:
    cards = []
    for conference_id in ids:
        profile = json.loads((CONFERENCES_DIR / conference_id / "conference.json").read_text(encoding="utf-8"))
        cards.append(
            f'<a class="conference" href="./{conference_id}/"><strong>{profile["name"]}</strong>'
            f'<span>{profile["description"]}</span><small>{profile["guide"]["conference_dates"]} · {profile["location"]}</small></a>'
        )
    template = (WEB_DIR / "landing.html").read_text(encoding="utf-8")
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / "index.html").write_text(template.replace("{{CONFERENCE_CARDS}}", "\n".join(cards)), encoding="utf-8")
    _copy(WEB_DIR / "firebase-config.json", DOCS_DIR / "firebase-config.json")
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the static multi-conference site")
    parser.add_argument("--conference", action="append", choices=conference_ids())
    parser.add_argument(
        "--rebuild-projections",
        action="store_true",
        help="Explicitly recompute PCA, t-SNE, and UMAP instead of preserving checked-in projections",
    )
    parser.add_argument(
        "--rebuild-preference-features",
        action="store_true",
        help="Explicitly recompute browser preference PCA and clusters instead of preserving checked-in features",
    )
    args = parser.parse_args()
    ids = args.conference or conference_ids()
    cached_projections = {
        conference_id: (DOCS_DIR / conference_id / "data" / "projection.json").read_bytes()
        for conference_id in ids
        if (DOCS_DIR / conference_id / "data" / "projection.json").exists()
    }
    cached_preferences = {
        conference_id: (DOCS_DIR / conference_id / "data" / "preference-features.json").read_bytes()
        for conference_id in ids
        if (DOCS_DIR / conference_id / "data" / "preference-features.json").exists()
    }
    if args.conference:
        for conference_id in ids:
            destination = DOCS_DIR / conference_id
            if destination.exists():
                shutil.rmtree(destination)
    elif DOCS_DIR.exists():
        shutil.rmtree(DOCS_DIR)
    for conference_id in ids:
        build_conference(
            conference_id,
            cached_projection=cached_projections.get(conference_id),
            cached_preference=cached_preferences.get(conference_id),
            rebuild_projection=args.rebuild_projections,
            rebuild_preference=args.rebuild_preference_features,
        )
    build_landing(conference_ids())


if __name__ == "__main__":
    main()
