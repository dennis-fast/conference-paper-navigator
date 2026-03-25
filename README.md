# EACL 2026 Preference Arena

Interactive browser app to rank EACL papers, inspect a 2D embedding projection, and build oral/poster schedules.

## Intended use

This workspace is designed to help EACL 2026 participants:

- explore individual papers in session context,
- explore clusters of semantically similar papers via embedding projections,
- learn personal relevance preferences through pairwise ranking,
- generate a practical in-person oral session plan,
- produce a ranked poster shortlist to visit.

## Venue structure (as represented in the loaded EACL 2026 program CSV)

- **Conference days:** Wed. Mar 25, Thur. Mar 26, Fri. Mar 27
- **Main time blocks:** 09:00–10:30, 11:00–12:30, 11:30–13:00, 14:30–16:00, 16:30–18:00
- **In-person rooms:** SALLE LE LIXUS, SALLE LE RIAD, SALLE LA PALMERAIE, SALLE WALILI, SALLE Le Chellah, Pavillon DE RABAT
- **Poster area:** POSTER HALL
- **Virtual entries:** ZOOM / Attendance Type = Virtual

The app uses this structure to organize papers and to derive planning recommendations per day, session, room, and time slot.

## Tab-by-tab guide

- **Overview**
   - Purpose: inspect singular papers in conference context.
   - View: grouped by Date → Session → Location.
   - Typical use: scan sessions, then filter/search by topic, session, and location.
   - Includes: global search, category/session/location filters, wins-only visibility filter, `Oral only (in-person)`, and `Oral only (in-person, no Salle Le Chellah)` shortcuts.

- **2D Embeddings**
   - Purpose: inspect paper clusters by semantic similarity.
   - View: precomputed PCA/t-SNE/UMAP projections in static mode.
   - Typical use: find neighborhoods of related papers, run search highlight/filter, inspect nearest neighbors.
   - Includes: method switch, projection controls, session/all mode, oral-only shortcut, sampling, CSV export of selected/projected points.

- **Pairwise Ranking**
   - Purpose: convert your preferences into a personalized ranking.
   - View: two-paper arena with active/random/bubble/tie-resolution pairing modes.
   - Typical use: rate pairs quickly and refine the live top-paper list.
   - Includes: A/B/Strong/Both/Neither/Skip/Undo actions, global pairing priorities (`muPriority`, `resolveTieNMatches`), top-N bubble focus.

- **Oral Schedule**
   - Purpose: support attendance planning for in-person oral sessions.
   - View: either room-based recommendations per slot or presentation-based recommendations grouped by within-session order.
   - Typical use: decide where to go each time block with preference-aware guidance, or compare the best-rated talk for each presentation order across simultaneous sessions.
   - Includes: slot-level primary + backup room choices, presentation-order mode, and displayed `μ` / `wins` for both primary and backup recommendations.

- **Posters**
   - Purpose: prioritize poster exploration.
   - View: poster sessions grouped by date/time with papers sorted by your current rank.
   - Typical use: create a high-value poster route for your available time.
   - Includes: rank-first ordering to quickly identify highest-value poster stops.

## Landing page / guide tab

The web app starts with a **How to use** tab that explains:

- intended workflow across all tabs,
- venue/session structure used for planning,
- each function in the app including top-bar data/state controls.

## GitHub sharing model

This project is prepared for **GitHub Pages** under:

- `https://dennis-fast.github.io/eacl26-pref-arena/`

The shareable app is served from the `docs/` folder and runs **fully client-side**:

- state is stored in browser `localStorage`
- exports are downloaded as files (no server-side file writes)

## Project structure

- `docs/` → GitHub Pages publish root
   - `docs/index.html` → unified app (overview, ranking, oral schedule, posters, embedded viz)
   - `docs/assets/js/` → client logic + shared modules
   - `docs/assets/css/` → styles
   - `docs/viz/` → static 2D projection page
   - `docs/data/` → static artifacts served in Pages
- `apps/flask/` → Flask backend app (legacy/server runtime)
- `legacy/web/` → legacy server-rendered web assets used by Flask
- `src/web/` → canonical frontend source files
- `scripts/build/sync_web_assets.py` → publishes `src/web` files into `docs/` and `legacy/web/`
- `data/raw/` → source datasets and embeddings
- `data/generated/` → runtime-generated outputs (state/scored CSV)
- `scripts/`
   - `scripts/build/` → artifact generation scripts
   - `scripts/analysis/` → analysis and utility scripts
- `config/paths.py` → centralized filesystem path constants used by server/build/analysis scripts

## Local preview (Pages-equivalent)

From repo root:

```bash
python -m http.server 8000
```

Open:

- `http://localhost:8000/docs/`

Or use:

```bash
make serve-pages
```

## Regenerate static projection artifact

When the CSV or embeddings change:

```bash
python scripts/build/build_static_projection.py
```

This rebuilds:

- `docs/data/projection_pca.json`

## Sync frontend assets

After editing files in `src/web/`, sync to deploy/runtime folders:

```bash
python scripts/build/sync_web_assets.py
```

Or use:

```bash
make sync
```

## Common developer tasks

```bash
make build-all       # sync frontend assets + rebuild projection JSON
make serve-pages     # preview GitHub Pages app
make serve-flask     # run legacy Flask app
make smoke-flask     # quick API smoke test
make test            # run structural + Flask smoke tests
```

## CI

GitHub Actions workflow is defined in [.github/workflows/ci.yml](.github/workflows/ci.yml).

On each push/PR it runs:

- `make build-all`
- `make test`

## GitHub Pages deployment

Deployment workflow is defined in [.github/workflows/pages.yml](.github/workflows/pages.yml).

It runs on pushes to `main` and:

- builds docs via `make build-all`
- deploys the `docs/` folder to GitHub Pages

Repository settings requirement:

- Settings → Pages → Build and deployment → Source: **GitHub Actions**

## Main functionality

- Pairwise ranking with uncertainty-aware Elo updates
- Overview grouped by date/session/location with rank-aware sorting
- Oral-only location shortcuts, including exclusion of Salle Le Chellah
- Oral schedule recommendations with two modes: room-based (topic match + ranking signals) and presentation-order-based
- Posters grouped by date/time and sorted by rank
- Static 2D embedding projection (precomputed PCA/t-SNE/UMAP)
- Backend-free `docs/viz` interaction: filtering, search highlight/filter, sampling, nearest neighbors from static artifact

## CSV columns (minimum)

Required:

- `Paper number` (or equivalent ID)
- `Title`
- `Abstract`

Recommended for scheduling and filtering:

- `Session`, `Room Location`, `Session Date`, `Session time`
- `Order` (within-session presentation order for Oral Schedule presentation mode)
- `Type of Presentation`, `Attendance Type`
- `category_primary`, `category_secondary`, `keywords`

## Backend-free visualization notes

The visualization page (`docs/viz`) no longer requires `/api/meta`, `/api/project`, or `/api/nn`.
It loads from:

- `docs/data/projection_pca.json`

The artifact now includes:

- `points_meta`
- `methods` (`pca`, `tsne`, `umap`)
- `neighbors`
- filter/session metadata used by the UI

In Flask mode, static docs data is also served at:

- `/data/<filename>`

which enables unified-app CSV auto-load (`/data/EACL_2026_program_categorized.csv`) without needing GitHub Pages.

## Testing

`make test` uses unittest discovery and runs all `test_*.py` modules under `tests/`, including:

- smoke tests (`tests/test_smoke.py`)
- static viz contract + integration checks (`tests/test_static_viz_contract.py`)
