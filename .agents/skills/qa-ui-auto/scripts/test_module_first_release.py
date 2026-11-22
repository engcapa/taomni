"""Pure contracts for selecting the signed business roster on a native runner."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from modular_bundle_inventory import digest
from qa_ui_auto.fixtures.module_first_release import CATALOG, release_inputs
from qa_ui_auto.fixtures.module_marketplace import ORIGIN


class FirstReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.modules = self.root / "modules"
        self.catalog = self.root / "catalog" / CATALOG
        self.catalog.parent.mkdir()
        self.sha = "a" * 40
        self.target = "linux-x86_64"
        slugs = ["mail", "mfa", "darwin-only"]
        self.frozen = ["taomni-plugin-" + slug for slug in slugs]
        self.document = {"legacyUpgrade": self.frozen, "plugins": {}}
        self.producer = {"sourceSha": self.sha, "runId": "123", "packages": []}
        self.artifacts = {}
        for slug, module_id in zip(slugs, self.frozen):
            target = "darwin-aarch64" if slug == "darwin-only" else self.target
            manifest = {"id": module_id, "slug": slug, "version": "1.2.0", "platforms": [target]}
            module = self.modules / slug
            module.mkdir(parents=True)
            (module / "module.json").write_text(json.dumps(manifest))
            name = f"module-signed-{slug}-{target}-123"
            directory = self.root / "packages" / name / "signed-module"
            directory.mkdir(parents=True)
            archive = directory / f"{module_id}-1.2.0-{target}.taomni-plugin"
            archive.write_bytes(module_id.encode())
            receipt = {"id": module_id, "platform": target, "archive": archive.name, "sha256": digest(archive),
                       "slug": slug, "version": "1.2.0", "size": archive.stat().st_size, "sourceSha": self.sha}
            self.artifacts[directory] = receipt, archive, "test-signature\n", None
            self.producer["packages"].append({"artifact": name, "package": receipt})
            asset = {"url": f"{ORIGIN}/{archive.name}", "size": receipt["size"], "sha256": receipt["sha256"],
                     "signature": "test-signature"}
            self.document["plugins"][module_id] = {**manifest, "platforms": {target: asset}}
        (self.modules / "legacy-upgrade.json").write_text(json.dumps(self.frozen))
        self.catalog.with_suffix(".json.minisig").write_text(f"trusted comment: file={CATALOG} sourceSha={self.sha}\n")

    def load(self, document=None, producer=None):
        self.catalog.write_text(json.dumps(self.document if document is None else document))
        provenance = {**self.producer, "catalogSha256": digest(self.catalog), **(producer or {})}
        (self.catalog.parent / "receipt.json").write_text(json.dumps(provenance))

        def package(directory, source, platform, slug, *, version):
            receipt, *rest = self.artifacts[directory]
            self.assertEqual((source, platform, slug, version),
                             (receipt["sourceSha"], receipt["platform"], receipt["slug"], receipt["version"]))
            return receipt, *rest

        with patch("qa_ui_auto.fixtures.module_first_release.load_artifact", side_effect=package):
            return release_inputs(self.root, self.sha, "123", self.target, ORIGIN, modules=self.modules)

    def test_uses_the_complete_frozen_roster_and_serves_only_compatible_archives(self):
        files, roster, producer = self.load()
        self.assertEqual(list(roster), self.frozen[:2])
        self.assertEqual(len(files), 4)
        for receipt in roster.values():
            self.assertEqual(digest(files["/" + receipt["archive"]]), receipt["sha256"])
        self.assertEqual(producer["catalogSha256"], digest(self.catalog))

    def test_rejects_substituted_source_missing_package_and_wrong_run(self):
        for patch_value in [{"sourceSha": "b" * 40}, {"runId": "999"}, {"catalogSha256": "c" * 64},
                            {"packages": self.producer["packages"][1:]}]:
            with self.subTest(change=list(patch_value)), self.assertRaises(RuntimeError):
                self.load(producer=patch_value)

    def test_omitted_roster_member_platform_and_different_asset_cannot_pass(self):
        partial = {**self.document, "legacyUpgrade": self.frozen[:-1]}
        missing = deepcopy(self.document)
        missing["plugins"][self.frozen[0]]["platforms"] = {}
        changed = deepcopy(self.document)
        changed["plugins"][self.frozen[0]]["platforms"][self.target]["signature"] = "another-signature"
        for label, change in [("roster", partial), ("platform", missing), ("signature", changed)]:
            with self.subTest(label=label), self.assertRaises(RuntimeError):
                self.load(change)
