# Conference Paper Navigator

A reusable, static-first application for exploring accepted papers, learning personal preferences through pairwise ranking, inspecting semantic neighborhoods, and planning oral and poster sessions.

The project grew out of the EACL 2026 Preference Arena. Conference-specific source formats are now isolated behind adapters while the browser application operates on one canonical paper-and-presentations schema.

## Included conferences

- **EACL 2026** — imported from the original program CSV: 703 papers
- **IJCAI-ECAI 2026** — imported from the public accepted-papers pages: 990 papers across 11 tracks

The generated GitHub Pages site presents a conference chooser and a separate state namespace for every conference.

## Data model

Ratings belong to papers. Scheduling belongs to presentations:

```text
Conference
 └── Paper
      ├── title, abstract, authors, track, topics
      └── presentations[]
           ├── oral
           ├── poster
           ├── demo
           └── other
```

This supports conferences where a paper appears in both an oral block and a poster block without duplicating its ranking identity.

The canonical JSON contract is versioned in `src/pipeline/schema.py`.

## Repository structure

```text
conferences/
  eacl-2026/
    conference.json       # Branding, source adapter, feature flags
    raw/                  # Pinned source snapshot
    data/                 # Normalized papers and embeddings
  ijcai-2026/
    conference.json
    raw/
    data/
src/
  pipeline/
    adapters/             # Conference-specific ingestion only
    cli.py                # Fetch, normalize, validate
    build.py              # Static site and projections
    schema.py             # Canonical contract
  web/
    app/                  # Generic planning application
    viz/                  # Generic embedding dashboard
    shared/               # Ranking, pair selection, CSV utilities
docs/                     # Generated GitHub Pages artifact
tests/                    # Schema, build, and frontend contracts
```

## Browser features

- paper overview with conference-derived filters
- browser-trained personal preference model seeded by favorites and pairwise feedback
- staged smart ranking: semantic discovery, schedule decisions, shortlist refinement, and exploration
- session-aware active questions for oral room conflicts and poster must-visit cutoffs
- uncertainty-aware Elo updates retained as direct per-paper evidence
- conference- and user-namespaced browser state, import, and export
- optional private cross-device synchronization with Google sign-in and Firestore
- PCA, t-SNE, and UMAP projections with nearest neighbours
- oral room recommendations by simultaneous time block
- optional talk-order comparison when the source publishes presentation order
- ranked poster and demo priorities
- scored CSV export

Personal ranking state always remains available in the browser. Optional Firebase sync can store a private copy for an authenticated user; it is disabled until a Firebase project is configured.

### Smart ranking and favorites

The build pipeline reduces the normalized SPECTER2 vectors to 48 compact preference dimensions and assigns deterministic semantic clusters. The browser downloads those static features and trains a small regularized linear model locally after every favorite or comparison. No personal preference data is sent to a model service.

New users can star promising papers in the overview, embedding inspector, ranking cards, oral schedule, or poster tables. Favorites are moderate positive seeds rather than permanent score overrides. Pairwise choices then teach the model which related papers are genuinely relevant. The smart selector initially samples broad semantic areas, then prioritizes comparisons that could change an oral-room recommendation or a poster-block cutoff. It periodically explores underrepresented areas and refines the global top-N boundary.

The ranking panel reports semantic coverage and decision stability. Oral recommendations combine the strongest two papers with the room mean; poster blocks distinguish must-visit favorites, likely visits, uncertain exploration candidates, and optional papers. Use **Resolve this slot** or **Refine this block** to focus subsequent comparisons on one decision.

**Full reset** clears every preference signal for the current conference and account: comparisons, direct ratings, imported priors, favorites, model predictions, focused decisions, and ranking settings. A reset marker prevents an older synchronized browser or Firestore copy from restoring cleared data.

## Ranking backups

Use **Export rankings** to download a JSON backup containing the conference ID, export timestamp, summary, favorites, ratings, comparison history, and ranking controls. Use **Import rankings** on another browser or device to restore it. Imports validate the schema and conference, then ask for confirmation before replacing the current rankings. Older raw state exports remain supported.

The scored CSV is useful for analysis, but it is not a restorable backup because it does not contain comparison history. Browser storage is isolated by site origin, device, and browser profile, so export periodically if cloud sync is not configured.

Ranking backups may also contain uncertain `priors`. Priors initialize the ordering without counting papers as reviewed; real pairwise votes update them normally. To transfer preferences between conferences that use the same embedding model:

```bash
python scripts/transfer_ranking_priors.py \
  eacl-rankings.json \
  conferences/eacl-2026/data/embeddings.npz \
  conferences/ijcai-2026/data/embeddings.npz \
  ijcai-priors.json \
  --conference-id ijcai-2026 \
  --conference-name "IJCAI-ECAI 2026"
```

The transfer blends ridge regression with distance-weighted semantic neighbours. It is intended to reduce cold-start work, not to replace reviewing the target conference.

## Optional cloud synchronization

The static app supports Google sign-in and Firestore without operating a custom server. Each conference state is stored at `users/{uid}/conferences/{conferenceId}` and protected by rules that compare the path UID with the authenticated user's UID. Comparison histories are merged transactionally using stable event IDs; undo and reset markers prevent removed comparisons from returning during a merge. Favorite additions and removals use per-paper timestamps so edits also merge safely across devices. Model weights are deterministically reconstructed from these signals and do not need to be synchronized.

Signing out stops cloud access but keeps the last synchronized ranking available on that device. Comparisons made while signed out are merged back into Firestore when the same account signs in again. Because that local copy remains visible, clear the site's browser data after signing out on a shared device.

Cloud sync is opt-in and fails back to local storage. Follow [FIREBASE_SETUP.md](FIREBASE_SETUP.md) to create the free Firebase project, deploy the included security rules, add the public web configuration, and enable synchronization.

## Common commands

Create or refresh normalized data:

```bash
python -m src.pipeline.cli normalize eacl-2026
python -m src.pipeline.cli fetch ijcai-2026
python -m src.pipeline.cli normalize ijcai-2026
```

The IJCAI fetch command stores a timestamped source snapshot. Fetching is deliberately separate from CI so a live conference website cannot break deployment reproducibility.

Generate embeddings after normalized papers change:

```bash
python scripts/compute_embeddings.py ijcai-2026 --device auto
```

Build, validate, and preview:

```bash
make build-all
make test
make serve
```

Then open `http://localhost:8000/docs/`.

Normal builds preserve the checked-in 2D projections so UMAP coordinates do not drift between environments. Recompute PCA, t-SNE, and UMAP only when embeddings or projection settings intentionally change:

```bash
python -m src.pipeline.build --rebuild-projections
```

## Adding another conference

1. Add `conferences/<conference-id>/conference.json`.
2. Implement a small adapter under `src/pipeline/adapters/`.
3. Normalize the source into `data/papers.json`.
4. Generate `data/embeddings.npz` with matching paper IDs.
5. Run `make build-all test`.

Adapters should contain source-specific parsing, not UI behavior. Feature flags in the conference profile indicate whether oral schedules, poster schedules, or explicit presentation order are available.

## Source snapshots

Conference metadata remains attributable to its publisher through `source.url`, per-paper `source_url`, and `raw/source.json`. Refreshing a snapshot may change schedules; ranking state remains stable because it is keyed by conference and paper ID.

## Deployment

GitHub Actions builds every configured conference and deploys `docs/` to GitHub Pages on pushes to `main`.
