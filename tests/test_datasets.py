import json
import unittest
from collections import Counter
from pathlib import Path

from src.pipeline.schema import validate_dataset

ROOT = Path(__file__).resolve().parents[1]


class DatasetContractTests(unittest.TestCase):
    def load(self, conference_id: str) -> dict:
        return json.loads((ROOT / "conferences" / conference_id / "data" / "papers.json").read_text(encoding="utf-8"))

    def test_all_datasets_satisfy_schema(self):
        for conference_id in ("eacl-2026", "ijcai-2026"):
            with self.subTest(conference=conference_id):
                dataset = self.load(conference_id)
                self.assertEqual([], validate_dataset(dataset))
                self.assertEqual(conference_id, dataset["conference_id"])

    def test_eacl_snapshot(self):
        papers = self.load("eacl-2026")["papers"]
        kinds = Counter(item["type"] for paper in papers for item in paper["presentations"])
        self.assertEqual(703, len(papers))
        self.assertEqual(224, kinds["oral"])
        self.assertEqual(435, kinds["poster"])
        self.assertEqual(44, kinds["demo"])

    def test_ijcai_snapshot_and_dual_presentations(self):
        papers = self.load("ijcai-2026")["papers"]
        kinds = Counter(item["type"] for paper in papers for item in paper["presentations"])
        tracks = {paper["track"] for paper in papers}
        dual = [paper for paper in papers if {item["type"] for item in paper["presentations"]} >= {"oral", "poster"}]
        self.assertEqual(990, len(papers))
        self.assertEqual(989, kinds["oral"])
        self.assertEqual(926, kinds["poster"])
        self.assertEqual(11, len(tracks))
        self.assertGreater(len(dual), 900)

    def test_embedding_ids_match_papers(self):
        import numpy as np
        for conference_id in ("eacl-2026", "ijcai-2026"):
            with self.subTest(conference=conference_id):
                papers = self.load(conference_id)["papers"]
                npz = np.load(ROOT / "conferences" / conference_id / "data" / "embeddings.npz", allow_pickle=True)
                ids = {str(value) for value in npz["ids"]}
                self.assertEqual({str(paper["id"]) for paper in papers}, ids)


if __name__ == "__main__":
    unittest.main()
