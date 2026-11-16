"""Pure fixture/oracle units; no sockets, browser or native process is opened."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.fixtures.module_marketplace import ORIGIN, fixture_files, setup
from qa_ui_auto.module_marketplace_observation import run
from qa_ui_auto.steps import StepError


class MarketplaceTests(unittest.TestCase):
    def fixture(self, root):
        receipt = {"id":"taomni-plugin-hello-plugin", "platform":"linux-x86_64", "sourceSha":"b" * 40,
                   "archive":"hello.taomni-plugin", "sha256":"a" * 64, "size":123}
        for name, sequence in [("modules.json",42),("modules-older.json",41)]:
            data = {"sequence":sequence, "plugins":{receipt["id"]:{"name":"Hello Plugin", "platforms":{
                receipt["platform"]:{"url":ORIGIN + "/hello.taomni-plugin", "sha256":receipt["sha256"],"size":123}}}}}
            (root / name).write_text(json.dumps(data))
            (root / (name + ".minisig")).write_text("trusted comment: file=" + name + " sourceSha=" + receipt["sourceSha"] + "\n")
        (root / receipt["archive"]).write_bytes(b"input fixture, not a cryptographic proof")
        return receipt

    def test_fixture_preserves_signed_bytes_and_mutates_only_the_adversarial_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = self.fixture(root)
            files = fixture_files(root, receipt)
            self.assertEqual(files["/modules.json"], (root / "modules.json").read_bytes())
            self.assertNotEqual(files["/modules-bad.json"], files["/modules.json"])
            self.assertEqual(files["/modules-bad.json.minisig"], files["/modules.json.minisig"])
            receipt["sha256"] = "c" * 64
            with self.assertRaisesRegex(RuntimeError, "does not bind"):
                fixture_files(root, receipt)

    def test_source_mismatch_missing_inputs_and_path_escape_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = self.fixture(root)
            receipt["archive"] = "../external"
            with self.assertRaisesRegex(RuntimeError, "filename"):
                fixture_files(root, receipt)
            receipt = self.fixture(root)
            receipt["sourceSha"] = "d" * 40
            with self.assertRaisesRegex(RuntimeError, "source identity"):
                fixture_files(root, receipt)
            receipt = self.fixture(root)
            (root / "modules-older.json").unlink()
            with self.assertRaisesRegex(RuntimeError, "missing"):
                fixture_files(root, receipt)

    def test_browser_mode_cannot_start_the_native_fixture_and_yaml_cannot_choose_inputs(self):
        with self.assertRaisesRegex(RuntimeError, "native"):
            setup(SimpleNamespace(cfg={"app":{"mode":"browser"}}))
        for args in [{"phase":"source", "url":"http://untrusted"}, {"phase":"install"}, "source"]:
            with self.assertRaisesRegex(StepError, "fixed phase"):
                run(None, args)

    def test_source_configures_only_transport_without_creating_registry_or_trust_state(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=Path(directory), module_marketplace=object(), session=Mock())
            with patch("qa_ui_auto.module_marketplace_observation.plugin_root", return_value=Path(directory)):
                run(ctx, {"phase":"source"})
            script = ctx.session.execute.call_args.args[0]
            self.assertIn("taomni.module-catalog-source.v1", script)
            self.assertNotIn("plugin_install", script)
            self.assertNotIn("invoke", script)
            self.assertFalse((Path(directory) / ".catalog-trust").exists())

    def test_oracle_rejects_duplicate_transfers_and_changed_working_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"signed package bytes"
            digest = hashlib.sha256(data).hexdigest()
            (root / "official-module-fixture.json").write_text(json.dumps({"archive":"hello.pkg","sha256":digest}))
            downloads = root / ".downloads"
            downloads.mkdir()
            (downloads / (digest + ".taomni-plugin")).write_bytes(data)
            cache = root / ".catalog-trust"
            cache.mkdir()
            (cache / "catalog.json").write_text(json.dumps({"payload":"changed cache"}))
            origin = SimpleNamespace(requests=["/hello.pkg","/hello.pkg"], files={"/modules.json":b"original"})
            ctx = SimpleNamespace(case_dir=root, module_marketplace=origin)
            with patch("qa_ui_auto.module_marketplace_observation.plugin_root", return_value=root):
                with self.assertRaisesRegex(StepError, "exactly one"):
                    run(ctx, {"phase":"downloaded"})
                origin.requests = ["/hello.pkg"]
                with self.assertRaisesRegex(StepError, "working cache"):
                    run(ctx, {"phase":"downloaded"})
            rows = [json.loads(line) for line in (root / "module-marketplace-observations.jsonl").read_text().splitlines()]
            self.assertTrue(all(row["passed"] is False for row in rows))


if __name__ == "__main__":
    unittest.main()
