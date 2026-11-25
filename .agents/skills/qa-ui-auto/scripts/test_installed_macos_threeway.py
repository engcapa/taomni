from itertools import permutations
import json
from pathlib import Path
import tempfile
import unittest

from installed_macos_threeway import LABELS, activate, validate_experiment


class ThreeWayMemoryTests(unittest.TestCase):
    def test_six_orders_measure_each_position_twice_and_restore_frozen_app(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            target = work / "Taomni.app"
            target.write_text("frozen")
            (work / "experimental.app").write_text("experiment")
            (work / "original.app").write_text("stable")
            orders = list(permutations(LABELS))
            for label in LABELS:
                self.assertEqual(
                    [sum(order[i] == label for order in orders) for i in range(3)],
                    [2, 2, 2],
                )
            for order in orders:
                for label in order:
                    with activate(label, target, work):
                        self.assertEqual(target.read_text(), label)
                    self.assertEqual(target.read_text(), "frozen")
            with self.assertRaisesRegex(RuntimeError, "test failed sample"):
                with activate("experiment", target, work):
                    raise RuntimeError("test failed sample")
            self.assertEqual(target.read_text(), "frozen")

    def test_producer_and_fixed_signature_match_an_independent_arm64_product(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            source_sha, frozen, certificate = "1" * 40, "2" * 40, "A" * 40
            (work / "producer.json").write_text(json.dumps({"head_sha": source_sha}))
            build = {
                "sourceSha": source_sha,
                "arch": "aarch64",
                "certificateSha1": certificate,
                "staticKerberos": False,
                "signingMode": "self-signed",
            }

            def store(changes):
                (work / "macos-build-identity.json").write_text(
                    json.dumps(build | changes)
                )

            store({})
            self.assertEqual(validate_experiment(work, certificate, frozen)[1], build)
            with self.assertRaises(RuntimeError):
                validate_experiment(work, certificate, source_sha)
            for override in [
                {"certificateSha1": "0" * 40},
                {"staticKerberos": True},
                {"arch": "x86_64"},
                {"sourceSha": frozen},
                {"signingMode": "ad-hoc"},
            ]:
                store(override)
                with self.assertRaises(RuntimeError):
                    validate_experiment(work, certificate, frozen)
