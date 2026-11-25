"""Pure fixture/oracle units; no sockets, browser or native process is opened."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.fixtures.module_marketplace import BASELINE_CATALOG, NEW_MODULE_CATALOG, ORIGIN, fixture_files, setup
from qa_ui_auto.module_marketplace_observation import observe_legacy_roster, run
from qa_ui_auto.steps import StepError


class MarketplaceTests(unittest.TestCase):
    def fixture(self, root):
        receipt = {"id":"taomni-plugin-hello-plugin", "platform":"linux-x86_64", "sourceSha":"b" * 40,
                   "archive":"hello.taomni-plugin", "sha256":"a" * 64, "size":123}
        plugins = {receipt["id"]: {"name": "Hello Plugin", "platforms": {
            receipt["platform"]: {"url": ORIGIN + "/hello.taomni-plugin", "sha256": receipt["sha256"], "size": 123}}}}
        for name, sequence, entries in [
            ("modules.json", 42, plugins), ("modules-older.json", 41, plugins),
            (BASELINE_CATALOG, 43, {}), (NEW_MODULE_CATALOG, 44, plugins),
        ]:
            data = {"sequence":sequence, "plugins":entries, "legacyUpgrade":[]}
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
            origin = SimpleNamespace(start_catalog=BASELINE_CATALOG)
            ctx = SimpleNamespace(case_dir=Path(directory), module_marketplace=origin, session=Mock())
            with patch("qa_ui_auto.module_marketplace_observation.plugin_root", return_value=Path(directory)):
                run(ctx, {"phase":"source"})
            script = ctx.session.execute.call_args.args[0]
            self.assertIn("taomni.module-catalog-source.v1", script)
            self.assertIn(f"{ORIGIN}/{BASELINE_CATALOG}", script)
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
            origin = SimpleNamespace(requests=["/hello.pkg","/hello.pkg"], current_catalog=b"original")
            ctx = SimpleNamespace(case_dir=root, module_marketplace=origin)
            with patch("qa_ui_auto.module_marketplace_observation.plugin_root", return_value=root):
                with self.assertRaisesRegex(StepError, "exactly one"):
                    run(ctx, {"phase":"downloaded"})
                origin.requests = ["/hello.pkg"]
                with self.assertRaisesRegex(StepError, "working cache"):
                    run(ctx, {"phase":"downloaded"})
            rows = [json.loads(line) for line in (root / "module-marketplace-observations.jsonl").read_text().splitlines()]
            self.assertTrue(all(row["passed"] is False for row in rows))

    def test_opt_in_fixture_rejects_a_new_catalog_that_enrolls_the_optional_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = self.fixture(root)
            files = fixture_files(root, receipt, opt_in=True)
            self.assertEqual(json.loads(files["/" + BASELINE_CATALOG])["plugins"], {})
            self.assertIn(receipt["id"], json.loads(files["/" + NEW_MODULE_CATALOG])["plugins"])
            catalog = json.loads(files["/" + NEW_MODULE_CATALOG])
            catalog["legacyUpgrade"] = [receipt["id"]]
            (root / NEW_MODULE_CATALOG).write_text(json.dumps(catalog))
            with self.assertRaisesRegex(RuntimeError, "outside the legacy"):
                fixture_files(root, receipt, opt_in=True)

    def test_optional_module_probe_checks_actual_transfer_and_durable_choice(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            root = profile / "plugins"
            receipt = {"archive": "hello.pkg", "sha256": "b" * 64, "slug": "hello-plugin", "id": "taomni-plugin-hello-plugin"}
            (profile / "official-module-fixture.json").write_text(json.dumps(receipt))
            origin = SimpleNamespace(requests=["/" + BASELINE_CATALOG, "/" + NEW_MODULE_CATALOG])
            state_file = profile / ".module-release.json"
            state = {"sequence": 44, "seen": [receipt["id"]], "newModules": [receipt["id"]]}
            state_file.write_text(json.dumps(state))
            ctx = SimpleNamespace(case_dir=profile, module_marketplace=origin)
            with patch("qa_ui_auto.module_marketplace_observation.plugin_root", return_value=root):
                run(ctx, {"phase": "new-available"})
                with self.assertRaisesRegex(StepError, "persisted"):
                    run(ctx, {"phase": "new-dismissed"})
                state_file.write_text(json.dumps({**state, "newModules": []}))
                run(ctx, {"phase": "new-dismissed"})
                origin.requests.append("/hello.pkg")
                with self.assertRaisesRegex(StepError, "before user consent"):
                    run(ctx, {"phase": "new-dismissed"})

    def test_first_upgrade_requires_both_signed_packages_and_keeps_mfa_after_hello_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloads = root / ".downloads"
            downloads.mkdir()
            roster = {}
            requests = []
            for slug in ("hello-plugin", "mfa"):
                package = slug.encode()
                digest = hashlib.sha256(package).hexdigest()
                archive = f"{slug}.taomni-plugin"
                (downloads / (digest + ".taomni-plugin")).write_bytes(package)
                proof = root / slug / "versions/0.1.0/.taomni-trust"
                proof.mkdir(parents=True)
                (proof / "package.taomni-plugin").write_bytes(package)
                (root / slug / "active.json").write_text(json.dumps({"activeVersion": "0.1.0", "previousVersion": None}))
                roster[slug] = {"slug": slug, "version": "0.1.0", "sha256": digest, "archive": archive}
                requests.append("/" + archive)
            origin = SimpleNamespace(roster=roster, requests=requests)
            self.assertEqual(set(observe_legacy_roster(root, origin, None)), set(roster))
            (root / "hello-plugin/active.json").write_text(json.dumps({"activeVersion": None, "previousVersion": "0.1.0"}))
            shutil.rmtree(root / "hello-plugin/versions")
            result = observe_legacy_roster(root, origin, "hello-plugin")
            self.assertEqual(result["mfa"]["activeVersion"], "0.1.0")
            requests.pop()
            with self.assertRaisesRegex(StepError, "exactly one signed package for mfa"):
                observe_legacy_roster(root, origin, "hello-plugin")


if __name__ == "__main__":
    unittest.main()
