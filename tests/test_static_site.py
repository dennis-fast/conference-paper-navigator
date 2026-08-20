import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class StaticSiteContractTests(unittest.TestCase):
    def test_landing_links_all_conferences(self):
        html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        self.assertIn("./eacl-2026/", html)
        self.assertIn("./ijcai-2026/", html)

    def test_each_site_has_required_assets(self):
        for conference_id, expected in (("eacl-2026", 703), ("ijcai-2026", 990)):
            with self.subTest(conference=conference_id):
                base = ROOT / "docs" / conference_id
                for relative in (
                    "index.html", "assets/js/app.js", "assets/js/cloud-sync.js", "assets/js/merge-comparisons.js", "assets/js/sync-fingerprint.js", "assets/js/rating.js", "assets/js/preference-model.js", "assets/css/styles.css",
                    "viz/index.html", "viz/app.js", "data/conference.json", "data/papers.json", "data/projection.json", "data/preference-features.json",
                ):
                    self.assertTrue((base / relative).exists(), relative)
                projection = json.loads((base / "data" / "projection.json").read_text(encoding="utf-8"))
                self.assertEqual(expected, projection["n_points"])
                self.assertEqual({"pca", "tsne", "umap"}, set(projection["methods"]))
                preference = json.loads((base / "data" / "preference-features.json").read_text(encoding="utf-8"))
                self.assertEqual(expected, len(preference["ids"]))
                self.assertEqual(expected, len(preference["features"]))
                self.assertGreaterEqual(preference["cluster_count"], 8)
                self.assertEqual(preference["dimensions"], len(preference["features"][0]))

    def test_cloud_sync_is_secure_and_configured(self):
        config = json.loads((ROOT / "src" / "web" / "firebase-config.json").read_text(encoding="utf-8"))
        rules = (ROOT / "firestore.rules").read_text(encoding="utf-8")
        source = (ROOT / "src" / "web" / "app" / "cloud-sync.js").read_text(encoding="utf-8")
        self.assertTrue(config["enabled"])
        self.assertEqual("conference-paper-navigator", config["firebase"]["projectId"])
        self.assertIn("request.auth.uid == userId", rules)
        self.assertIn('"users", user.uid, "conferences", conferenceId', source)
        self.assertIn("runTransaction", source)
        self.assertIn("syncStateWithRetry", source)
        self.assertIn("pendingSync = { candidate: structuredClone(candidate), user }", source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_cloud_sync_retries_version_conflicts(self):
        source = (ROOT / "src" / "web" / "app" / "cloud-sync.js").read_text(encoding="utf-8")
        source = re.sub(r'^import .*?;\n', "", source, flags=re.MULTILINE)
        source = re.sub(r"\bexport\s+", "", source)
        assertions = r"""
if (!isRetryableSyncError({code: "aborted"})) throw new Error("aborted should retry");
if (!isRetryableSyncError({code: "firestore/failed-precondition"})) throw new Error("failed precondition should retry");
if (!isRetryableSyncError({message: "stored version 2 does not match the required base version 1"})) throw new Error("version conflict should retry");
if (isRetryableSyncError({code: "permission-denied"})) throw new Error("permission errors must not retry");
if (retryDelayMs(0) !== 250 || retryDelayMs(3) !== 2000) throw new Error("retry backoff is incorrect");
"""
        subprocess.run(["node", "--input-type=module", "--eval", source + assertions], check=True, capture_output=True, text=True)

    def test_rendering_does_not_mutate_ranking_state(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const baseRating = readRating(paperId)", source)
        self.assertNotIn("const rating = getRating(String(paper.id))", source)
        self.assertNotIn("state.resolvedDecisionKeys = decisions.resolvedKeys", source)
        self.assertIn("const selectorState = { ...state, resolvedDecisionKeys: decisions.resolvedKeys }", source)
        self.assertIn("state.lastPair = [{ id: currentPair.A.id }, { id: currentPair.B.id }]", source)

    def test_visualization_updates_are_deduplicated(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")
        self.assertIn("lastVisualizationFingerprint", app_source)
        self.assertIn("notifyVisualization({ force: true })", app_source)
        self.assertIn("favoritesChanged && qs('favorite-neighborhood-toggle')?.checked", viz_source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_cloud_merge_preserves_additions_and_deletions(self):
        source = (ROOT / "src" / "web" / "app" / "merge-comparisons.js").read_text(encoding="utf-8")
        source = re.sub(r"\bexport\s+", "", source)
        assertions = r"""
const entry = (id, ts) => ({id, ts});
const local = {history: [entry("a", "2026-01-01T00:00:00Z"), entry("b", "2026-01-02T00:00:00Z")], history_tombstones: [], reset_at: "", modified_at: "2026-01-03T00:00:00Z"};
const remote = {history: [entry("a", "2026-01-01T00:00:00Z"), entry("c", "2026-01-03T00:00:00Z")], history_tombstones: ["b"], reset_at: "", modified_at: "2026-01-04T00:00:00Z"};
const merged = mergeComparisonData(local, remote);
if (merged.history.map((item) => item.id).join(",") !== "a,c") throw new Error("history merge failed");
if (!merged.history_tombstones.includes("b")) throw new Error("undo tombstone was lost");
if (merged.localIsNewer) throw new Error("newer state selection failed");
const reset = mergeComparisonData(local, {...remote, reset_at: "2026-01-02T12:00:00Z"});
if (reset.history.map((item) => item.id).join(",") !== "c") throw new Error("reset marker failed");
const favorites = mergeFavorites(
  {paper: {selected: true, modified_at: "2026-01-01T00:00:00Z"}, local: {selected: true, modified_at: ""}},
  {paper: {selected: false, modified_at: "2026-01-02T00:00:00Z"}, remote: {selected: true, modified_at: ""}},
);
if (favorites.paper.selected !== false) throw new Error("newer favorite removal was lost");
if (!favorites.local.selected || !favorites.remote.selected) throw new Error("one-sided favorite was lost");
const plans = mergeTimestampedRecords(
  {paper: {status: "planned", modified_at: "2026-01-03T00:00:00Z"}},
  {paper: {status: "attended", modified_at: "2026-01-04T00:00:00Z"}},
);
if (plans.paper.status !== "attended") throw new Error("newer personal plan was lost");
"""
        subprocess.run(["node", "--input-type=module", "--eval", source + assertions], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_cloud_fingerprint_ignores_firestore_key_order(self):
        source = (ROOT / "src" / "web" / "app" / "sync-fingerprint.js").read_text(encoding="utf-8")
        source = re.sub(r"\bexport\s+", "", source)
        assertions = r"""
const browser = {schema_version: 1, state: {ratings: {paper: {mu: 1500, n: 1}}, history: []}};
const firestore = {state: {history: [], ratings: {paper: {n: 1, mu: 1500}}}, schema_version: 1};
if (syncFingerprint(browser) !== syncFingerprint(firestore)) throw new Error("object key order changed the fingerprint");
if (syncFingerprint(browser) === syncFingerprint({...firestore, schema_version: 2})) throw new Error("real state change was ignored");
"""
        subprocess.run(["node", "--input-type=module", "--eval", source + assertions], check=True, capture_output=True, text=True)

    def test_state_keys_are_conference_scoped(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        self.assertIn("conference-paper-navigator:${config.id}", source)
        self.assertNotIn("eacl_pref_arena_state", source)

    def test_sign_out_preserves_and_reconnects_the_local_copy(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        sync_source = (ROOT / "src" / "web" / "app" / "cloud-sync.js").read_text(encoding="utf-8")
        self.assertIn("localStorage.setItem(guestStateKey(), JSON.stringify(state))", app_source)
        self.assertIn("localStorage.setItem(guestOwnerKey(), previousUserId)", app_source)
        self.assertIn("guestOwner === user.uid ? mergeStates(accountState, guestState)", app_source)
        self.assertIn('statusElement.textContent = "Signed out · saved on this device"', sync_source)

    def test_ranking_backup_contract(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        self.assertIn('STATE_EXPORT_TYPE = "conference-paper-navigator-state"', source)
        self.assertIn("exported_at", source)
        self.assertIn("parseStateBackup", source)
        self.assertIn("This backup belongs to", source)
        self.assertIn("This replaces the rankings currently stored", source)
        self.assertIn("Import rankings", html)
        self.assertIn("Export rankings", html)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_joint_feedback_is_uncertainty_aware(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        self.assertIn("rating.sigma / DEFAULT_SIGMA", source)
        self.assertIn("multiplier * uncertainty", source)

    def test_transferred_priors_seed_but_do_not_count_as_reviews(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")
        self.assertIn("priors: {}", app_source)
        self.assertIn("target.priors?.[id]", app_source)
        self.assertIn("effectiveRatings(state)", app_source)
        self.assertIn('Object.keys(state.priors).length', app_source)
        self.assertIn('["Model-scored",', app_source)
        self.assertIn("stateHasRankings", app_source)
        self.assertIn("target.priors?.[id]", app_source)
        self.assertIn("parsed?.priors || {}", viz_source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_favorites_seed_the_online_preference_model(self):
        module = (ROOT / "src" / "web" / "shared" / "preference-model.js").as_uri()
        assertions = f'''\nimport {{trainPreferenceModel, blendPreferencePrediction}} from "{module}";
const bundle = {{dimensions: 2, cluster_count: 3, ids: ["a", "b", "c", "d"], clusters: [0, 0, 1, 2], features: [[1,0],[0.9,0.1],[-1,0],[0,1]]}};
const state = {{favorites: {{a: {{selected: true, modified_at: "2026-01-01"}}}}, history: []}};
const model = trainPreferenceModel(bundle, state);
if (!model.hasSignal) throw new Error("favorite did not seed model");
if (!(model.predictions.get("a").mu > model.predictions.get("c").mu)) throw new Error("favorite direction was not learned");
if (!(model.predictions.get("b").mu > model.predictions.get("c").mu)) throw new Error("favorite did not generalize semantically");
const blended = blendPreferencePrediction({{mu:1500,sigma:350,n:0,wins:0,losses:0,ties:0}}, model.predictions.get("a"));
if (!blended.predicted || blended.mu <= 1500) throw new Error("prediction was not blended");
const topicModel = trainPreferenceModel(bundle, {{seedPaperIds: ["d"], history: [], favorites: {{}}}});
if (!topicModel.hasSignal) throw new Error("topic interests did not seed model");
if (!(topicModel.predictions.get("d").mu > topicModel.predictions.get("c").mu)) throw new Error("topic interest direction was not learned");
'''
        subprocess.run(["node", "--input-type=module", "--eval", assertions], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_smart_selector_can_target_an_oral_conflict(self):
        module = (ROOT / "src" / "web" / "shared" / "selector.js").as_uri()
        assertions = f'''\nimport {{chooseNextPair}} from "{module}";
const oral = (location) => [{{type:"oral",date:"Tuesday",time:"14:00",location}}];
const items = [
  {{id:"a",mu:1510,sigma:300,n:0,cluster:0,presentations:oral("Room A")}},
  {{id:"b",mu:1508,sigma:300,n:0,cluster:1,presentations:oral("Room B")}},
  {{id:"c",mu:1400,sigma:200,n:1,cluster:2,presentations:oral("Room A")}},
];
const state = {{mode:"smart",smartTarget:{{kind:"oral",key:"Tuesday|||14:00"}},history:[],lastPair:[],favorites:{{}},posterTarget:10}};
const result = chooseNextPair(items,state);
if (!result || result.target.kind !== "oral") throw new Error("oral target was ignored");
if (!result.reason.includes("room choice")) throw new Error("selection reason is missing");
if (result.pair[0].id === result.pair[1].id) throw new Error("invalid pair");
'''
        subprocess.run(["node", "--input-type=module", "--eval", assertions], check=True, capture_output=True, text=True)

    def test_favorites_are_available_across_workspaces(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")
        self.assertIn("favorites: {}", app_source)
        self.assertIn("modified_at", app_source)
        self.assertIn('data-tab="ranking">Smart Ranking', shell_html)
        self.assertIn('id="favoritesOnly"', shell_html)
        self.assertIn("favorite_update", viz_source)

    def test_agenda_and_personal_workflow_are_available(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        self.assertIn('data-tab="agenda">My Agenda', shell_html)
        self.assertIn('id="btnExportCalendar"', shell_html)
        self.assertIn('id="paperPlanner"', shell_html)
        self.assertIn("function renderAgenda()", app_source)
        self.assertIn("function exportAgendaCalendar()", app_source)
        self.assertIn("topicInterests: {}", app_source)
        self.assertIn("paperPlans: {}", app_source)
        self.assertIn("recommendationReason", app_source)
        self.assertIn("Your schedule decisions are stable", app_source)
        self.assertIn('paper.plan?.status !== "skipped"', app_source)
        self.assertIn("forcedIds.has(record.paper.id) || index < target", app_source)

    def test_embedding_supports_focused_exploration(self):
        viz_html = (ROOT / "src" / "web" / "viz" / "index.html").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")
        for element_id in ("favorite-neighborhood-toggle", "favorite-labels-toggle", "cluster-labels-toggle"):
            self.assertIn(f'id="{element_id}"', viz_html)
        self.assertIn("state.staticNeighbors?.[favoriteId]", viz_source)
        self.assertIn("name: 'Semantic areas'", viz_source)
        self.assertIn("function favoriteLabelAnnotations(points, axisRanges = null)", viz_source)
        self.assertIn("annotations: favoriteLabelAnnotations(points)", viz_source)
        self.assertIn("labelOverlap * 40 + markerOverlap * 65", viz_source)
        self.assertIn("function refreshFavoriteLabelLayout()", viz_source)
        self.assertIn("plot.on('plotly_relayout'", viz_source)

    def test_embedding_favorites_use_star_markers(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")
        self.assertIn("name: 'Favorites'", viz_source)
        self.assertIn("symbol: 'star'", viz_source)
        self.assertIn("const regularItems = items.filter((point) => !isFavorite(point.paper_id));", viz_source)
        self.assertIn("pointHoverTemplate(mode, true)", viz_source)
        self.assertIn("window.parent.postMessage({ type: 'viz_ready' }", viz_source)
        self.assertIn('event.data?.type === "viz_ready"', app_source)
        self.assertIn("size: 24", viz_source)

    def test_full_reset_clears_all_preference_signals(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="btnReset">Full reset', shell_html)
        self.assertIn("This clears comparisons, ratings, imported priors, favorites, topic interests, personal plans and notes", app_source)
        self.assertIn("state = { ...defaultState(), history_tombstones: tombstones, reset_at: resetAt }", app_source)
        self.assertIn("localResetIsNewer", app_source)
        self.assertIn("remoteResetIsNewer", app_source)
        self.assertNotIn("state = { ...defaultState(), priors: state.priors, favorites: state.favorites", app_source)

    def test_embedding_workspace_prioritizes_the_plot(self):
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        shell_css = (ROOT / "src" / "web" / "app" / "styles.css").read_text(encoding="utf-8")
        viz_html = (ROOT / "src" / "web" / "viz" / "index.html").read_text(encoding="utf-8")
        viz_css = (ROOT / "src" / "web" / "viz" / "styles.css").read_text(encoding="utf-8")
        viz_source = (ROOT / "src" / "web" / "viz" / "app.js").read_text(encoding="utf-8")

        self.assertIn('allow="fullscreen"', shell_html)
        self.assertIn("body.viz-active .wrap{max-width:none}", shell_css)
        for element_id in ("toggle-controls-btn", "focus-plot-btn", "toggle-inspector-btn", "fullscreen-btn", "category-legend"):
            self.assertIn(f'id="{element_id}"', viz_html)
        self.assertIn('class="advanced-settings"', viz_html)
        self.assertIn('id="selection-panel"', viz_html)
        self.assertIn('class="plot-stage"', viz_html)
        self.assertIn("grid-template-rows: auto minmax(0, 1fr)", viz_css)
        self.assertIn("position: absolute;\n  inset: 0 0 var(--selection-summary-height);", viz_css)
        self.assertIn(".selection-panel[open]", viz_css)
        self.assertIn("document.documentElement.requestFullscreen()", viz_source)
        self.assertIn("showlegend: false", viz_source)
        self.assertIn("renderCategoryLegend", viz_source)
        self.assertIn("if (layout.classList.contains(className) === collapsed) return;", viz_source)

    def test_mobile_layout_uses_compact_controls_and_schedule_cards(self):
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        shell_css = (ROOT / "src" / "web" / "app" / "styles.css").read_text(encoding="utf-8")
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")

        self.assertIn('class="data-menu"', shell_html)
        self.assertIn("@media (max-width:700px)", shell_css)
        self.assertIn("overflow-x:auto", shell_css)
        self.assertIn("content:attr(data-label)", shell_css)
        for label in ("Pick", "Room", "Top papers", "Priority", "Location", "Personal"):
            self.assertIn(f'data-label="{label}"', app_source)

    def test_overview_separates_room_contents_by_time(self):
        app_source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        shell_html = (ROOT / "src" / "web" / "app" / "index.html").read_text(encoding="utf-8")
        shell_css = (ROOT / "src" / "web" / "app" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('const time = paper.displayTime || "Time unavailable"', app_source)
        self.assertIn('class="overview-time"', app_source)
        self.assertIn("parseStartMinutes(a) - parseStartMinutes(b)", app_source)
        self.assertIn("day → session → room → time", shell_html)
        self.assertIn(".overview-time>summary", shell_css)

    def test_normal_builds_preserve_checked_in_projections(self):
        source = (ROOT / "src" / "pipeline" / "build.py").read_text(encoding="utf-8")
        self.assertIn('"--rebuild-projections"', source)
        self.assertIn("cached_projection is not None and not rebuild_projection", source)
        self.assertIn("projection_path.write_bytes(cached_projection)", source)
        self.assertIn('"--rebuild-preference-features"', source)
        self.assertIn("preference_path.write_bytes(cached_preference)", source)

    def test_generated_web_assets_match_sources(self):
        mappings = {
            "index.html": ROOT / "src" / "web" / "app" / "index.html",
            "assets/js/app.js": ROOT / "src" / "web" / "app" / "app.js",
            "assets/css/styles.css": ROOT / "src" / "web" / "app" / "styles.css",
            "viz/index.html": ROOT / "src" / "web" / "viz" / "index.html",
            "viz/app.js": ROOT / "src" / "web" / "viz" / "app.js",
            "viz/styles.css": ROOT / "src" / "web" / "viz" / "styles.css",
        }
        for conference_id in ("eacl-2026", "ijcai-2026"):
            for relative, source in mappings.items():
                with self.subTest(conference=conference_id, asset=relative):
                    self.assertEqual(source.read_bytes(), (ROOT / "docs" / conference_id / relative).read_bytes())

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_javascript_syntax(self):
        for path in (
            ROOT / "src" / "web" / "app" / "app.js",
            ROOT / "src" / "web" / "app" / "cloud-sync.js",
            ROOT / "src" / "web" / "app" / "merge-comparisons.js",
            ROOT / "src" / "web" / "app" / "sync-fingerprint.js",
            ROOT / "src" / "web" / "viz" / "app.js",
            ROOT / "src" / "web" / "shared" / "rating.js",
            ROOT / "src" / "web" / "shared" / "selector.js",
            ROOT / "src" / "web" / "shared" / "preference-model.js",
        ):
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
