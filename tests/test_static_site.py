import json
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
                    "index.html", "assets/js/app.js", "assets/js/rating.js", "assets/css/styles.css",
                    "viz/index.html", "viz/app.js", "data/conference.json", "data/papers.json", "data/projection.json",
                ):
                    self.assertTrue((base / relative).exists(), relative)
                projection = json.loads((base / "data" / "projection.json").read_text(encoding="utf-8"))
                self.assertEqual(expected, projection["n_points"])
                self.assertEqual({"pca", "tsne", "umap"}, set(projection["methods"]))

    def test_state_keys_are_conference_scoped(self):
        source = (ROOT / "src" / "web" / "app" / "app.js").read_text(encoding="utf-8")
        self.assertIn("conference-paper-navigator:${config.id}", source)
        self.assertNotIn("eacl_pref_arena_state", source)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_javascript_syntax(self):
        for path in (
            ROOT / "src" / "web" / "app" / "app.js",
            ROOT / "src" / "web" / "viz" / "app.js",
            ROOT / "src" / "web" / "shared" / "rating.js",
            ROOT / "src" / "web" / "shared" / "selector.js",
        ):
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
