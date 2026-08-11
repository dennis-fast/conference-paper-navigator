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
                    "index.html", "assets/js/app.js", "assets/js/cloud-sync.js", "assets/js/merge-comparisons.js", "assets/js/sync-fingerprint.js", "assets/js/rating.js", "assets/css/styles.css",
                    "viz/index.html", "viz/app.js", "data/conference.json", "data/papers.json", "data/projection.json",
                ):
                    self.assertTrue((base / relative).exists(), relative)
                projection = json.loads((base / "data" / "projection.json").read_text(encoding="utf-8"))
                self.assertEqual(expected, projection["n_points"])
                self.assertEqual({"pca", "tsne", "umap"}, set(projection["methods"]))

    def test_cloud_sync_is_secure_and_configured(self):
        config = json.loads((ROOT / "src" / "web" / "firebase-config.json").read_text(encoding="utf-8"))
        rules = (ROOT / "firestore.rules").read_text(encoding="utf-8")
        source = (ROOT / "src" / "web" / "app" / "cloud-sync.js").read_text(encoding="utf-8")
        self.assertTrue(config["enabled"])
        self.assertEqual("conference-paper-navigator", config["firebase"]["projectId"])
        self.assertIn("request.auth.uid == userId", rules)
        self.assertIn('"users", user.uid, "conferences", conferenceId', source)
        self.assertIn("runTransaction", source)

    def test_rendering_does_not_mutate_ranking_state(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const rating = readRating(String(paper.id))", source)
        self.assertNotIn("const rating = getRating(String(paper.id))", source)

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
    def test_javascript_syntax(self):
        for path in (
            ROOT / "src" / "web" / "app" / "app.js",
            ROOT / "src" / "web" / "app" / "cloud-sync.js",
            ROOT / "src" / "web" / "app" / "merge-comparisons.js",
            ROOT / "src" / "web" / "app" / "sync-fingerprint.js",
            ROOT / "src" / "web" / "viz" / "app.js",
            ROOT / "src" / "web" / "shared" / "rating.js",
            ROOT / "src" / "web" / "shared" / "selector.js",
        ):
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
