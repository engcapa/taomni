import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bench

MANIFEST = bench.ROOT / "qa-ui-auto-tests/fixtures/voice/benchmark-smoke.json"


class BenchmarkTests(unittest.TestCase):
    def test_edit_metrics_count_insertions_deletions_and_substitutions(self):
        score = bench.score("one two three", "one four")
        self.assertEqual(score["word_errors"], 2)
        self.assertAlmostEqual(score["wer"], 2 / 3)
        self.assertEqual(bench.score("你好", "你们好")["cer"], 0.5)
        self.assertEqual(bench.score("Hello， ＷＯＲＬＤ！", "hello world")["cer"], 0)
        self.assertTrue(bench.score("", "hallucination")["unexpected_text"])
        self.assertIsNone(bench.score("", "hallucination")["cer"])

    def test_existing_real_audio_and_missing_p0_coverage(self):
        _, samples = bench.load_manifest(MANIFEST)
        self.assertEqual(len(samples), 1)
        self.assertEqual(len(samples[0][1]), 664320)
        self.assertIn("zh: 1/20 speech recordings", bench.coverage(samples))
        self.assertIn("yue: 0/20 speech recordings", bench.coverage(samples))
        self.assertIn("mixed: 0/20 recordings", bench.coverage(samples))

    def test_rejects_wrong_hash_duration_and_duplicate_audio(self):
        source = json.loads(MANIFEST.read_text())
        source["samples"][0]["path"] = str(MANIFEST.parent / source["samples"][0]["path"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            for change in ("hash", "duration", "duplicate"):
                value = copy.deepcopy(source)
                if change == "hash":
                    value["samples"][0]["sha256"] = "0" * 64
                elif change == "duration":
                    value["samples"][0]["duration_s"] = 1
                else:
                    value["samples"].append({**value["samples"][0], "id": "duplicate"})
                path.write_text(json.dumps(value))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    bench.load_manifest(path)

    def test_rejects_nonfinite_or_unidentified_measurements(self):
        valid = {"text": "example", "engine": "fixture", "quantization": "f16", "model_sha256": "a" * 64,
                 "threads": 4, "inference_ms": 12, "cold_load_ms": 20}
        self.assertEqual(bench.validate_result(valid), valid)
        for patch_value in ({"inference_ms": float("nan")}, {"inference_ms": -1}, {"threads": 0}, {"model_sha256": "unknown"}):
            with self.subTest(value=patch_value), self.assertRaises(ValueError):
                bench.validate_result({**valid, **patch_value})

    def test_corpus_gate_rejects_smoke_without_running_adapter(self):
        with patch("sys.argv", ["bench", "--manifest", str(MANIFEST), "--require-p0-corpus", "--validate-only"]):
            self.assertEqual(bench.main(), 2)

class ExecutionTests(unittest.TestCase):
    def test_aggregate_is_weighted_by_reference_length(self):
        rows = [dict(id=str(i), language="en", category="speech", status="ok",
                     measurement={"engine": "fixture"}, scores=bench.score(ref, hyp))
                for i, (ref, hyp) in enumerate((("a", "b"), ("abcde", "abcde")))]
        self.assertAlmostEqual(bench.aggregate(rows)[0]["cer"], 1 / 6)

    def test_adapter_failure_is_retained_and_temporary_pcm_is_removed(self):
        from argparse import Namespace
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = root / "adapter.json"
            adapter.write_text(json.dumps({"command": [sys.executable, "-c", "raise SystemExit(3)"]}))
            args = Namespace(adapter=adapter, output=root / "run", manifest=MANIFEST, timeout=3)
            _, samples = bench.load_manifest(MANIFEST)
            self.assertEqual(bench.run(args, samples), 1)
            report = json.loads((args.output / "results.json").read_text())
            self.assertEqual(report["results"][0]["status"], "failed")
            self.assertNotIn("measurement", report["results"][0])
            self.assertEqual(report["aggregates"][0]["failed"], 1)
            self.assertFalse(list(args.output.glob("**/*.f32")))
            with self.assertRaises(FileExistsError):
                bench.run(args, samples)


if __name__ == "__main__":
    unittest.main()
