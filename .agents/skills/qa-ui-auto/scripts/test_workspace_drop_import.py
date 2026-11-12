"""Fixture, byte oracle and executable contracts without launching the app."""
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.behavior_contract import is_check, validate_contract
from qa_ui_auto.config import resolve
from qa_ui_auto.fixtures import REGISTRY
from qa_ui_auto.fixtures import workspace_drop_import as fixture
from qa_ui_auto import workspace_drop_observation as oracle
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case
from qa_ui_auto.verification import native_support

ROOT = Path(__file__).resolve().parents[4]


class WorkspaceDropImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.report = Path(self.directory.name)
        self.ctx = SimpleNamespace(
            cfg={"app": {"mode": "native"}}, values={}, report_root=self.report,
            case_dir=self.report / "TC-unit", case_id="TC-unit", worker_id=0,
        )
        fixture.setup(self.ctx)
        self.manifest_path = self.ctx.case_dir / "workspace-drop-import-fixture.json"
        self.manifest = json.loads(self.manifest_path.read_text())
        self.base = Path(self.manifest["base"])

    def assert_state(self, state):
        self.assertEqual(oracle.host_snapshot(self.base), self.manifest["states"][state])

    def copy_directory(self):
        source = self.base / "source"
        target = self.base / "root2/incoming"
        shutil.copy2(source / "中文 空格.txt", target / "中文 空格.txt")
        shutil.copy2(source / "second file.txt", target / "second file.txt")
        shutil.copytree(source / "递归 目录", target / "递归 目录")

    def test_native_fixture_creates_distinct_roots_external_sources_binary_and_empty_directory(self):
        self.assert_state("seeded")
        root1, root2 = (Path(self.ctx.values[f"workspace_drop_root{i}"]) for i in (1, 2))
        source = Path(self.ctx.values["workspace_drop_source"])
        self.assertFalse(source.is_relative_to(root1))
        self.assertFalse(source.is_relative_to(root2))
        self.assertNotEqual((source / "collision.txt").read_bytes(), (root2 / "incoming/collision.txt").read_bytes())
        self.assertEqual((source / "递归 目录/nested/binary.bin").read_bytes(), fixture.FILES["source/递归 目录/nested/binary.bin"])
        self.assertEqual(list((source / "递归 目录/empty folder").iterdir()), [])
        document = json.loads(self.ctx.values["workspace_drop_workspace"])
        roots = document["workspaces"][0]["rootFolders"]
        self.assertEqual([root["id"] for root in roots], ["root1", "root2"])
        self.assertTrue(self.base.is_relative_to(self.report))
        self.assertIs(REGISTRY["workspace_drop_import"].setup, fixture.setup)

    def test_repeated_fixture_isolation_and_evidence_retention(self):
        before = self.base
        fixture.teardown(self.ctx)
        self.assertTrue(before.exists())
        fixture.setup(self.ctx)
        self.assertNotEqual(self.ctx.values["workspace_drop_root1"], (before / "root1").as_posix())
        self.assertTrue(before.exists())

    def test_browser_fixture_seeds_vfs_bytes_only_and_exports_equivalent_manifest(self):
        page = Mock()
        ctx = SimpleNamespace(cfg={"app": {"mode": "browser", "base_url": "http://fixture.invalid"}},
                              values={}, page=page, case_dir=self.report / "browser-case")
        fixture.setup(ctx)
        page.goto.assert_called_once()
        script, payload = page.evaluate.call_args.args
        self.assertIn("vfsWriteBytes", script)
        self.assertNotIn("workspace_import_paths", script)
        self.assertTrue(payload["base"].startswith("/preview/workspace-drop-import-"))
        self.assertEqual(bytes(payload["files"]["source/递归 目录/nested/binary.bin"]), fixture.FILES["source/递归 目录/nested/binary.bin"])
        self.assertIn(fixture.EMPTY_DIR, payload["directories"])
        self.assertEqual(payload["directories"][0], "")
        self.assertLess(payload["directories"].index("source"), payload["directories"].index("source/递归 目录/nested"))
        manifest = json.loads((ctx.case_dir / "workspace-drop-import-fixture.json").read_text())
        self.assertEqual(manifest["states"], self.manifest["states"])
        self.assertEqual(manifest["mode"], "browser")
        self.assertFalse(any(child.name.startswith("workspace-drop-import-") for child in self.report.iterdir()))

    def test_expected_states_match_independent_host_copies_and_preserve_sources(self):
        self.copy_directory()
        self.assert_state("directory")
        shutil.copy2(self.base / "source/recovery fresh.txt", self.base / "root2/incoming/recovery fresh.txt")
        self.assert_state("recovered")
        shutil.copy2(self.base / "source/root file.txt", self.base / "root2/root file.txt")
        self.assert_state("root")
        self.assertTrue((self.base / "source/中文 空格.txt").is_file())
        self.assertFalse((self.base / "root1/incoming/中文 空格.txt").exists())

    def test_oracle_observes_a_full_quiet_interval_and_writes_raw_hash_samples(self):
        elapsed = [0.0]
        with patch.object(oracle.time, "monotonic", side_effect=lambda: elapsed[0]), \
                patch.object(oracle.time, "sleep", side_effect=lambda delay: elapsed.__setitem__(0, elapsed[0] + delay)):
            result = oracle.run(self.ctx, {"state": "seeded"}, mode="native")
        record = json.loads((self.ctx.case_dir / "workspace-drop-import-observations.jsonl").read_text().splitlines()[0])
        self.assertTrue(record["passed"])
        self.assertGreaterEqual(record["samples"][-1]["elapsedMs"], 500)
        self.assertEqual(record["samples"][0]["observed"], self.manifest["states"]["seeded"])
        self.assertIn("SHA-256", result)

    def test_changed_target_moved_source_extra_file_or_lost_empty_directory_fail_immediately(self):
        for mutation in ("overwrite", "move-source", "pollute-root1", "empty-dir"):
            with self.subTest(mutation=mutation):
                if mutation == "overwrite":
                    target = self.base / "root2/incoming/collision.txt"
                    original = target.read_bytes()
                    target.write_bytes(b"wrong bytes")
                    restore = lambda: target.write_bytes(original)
                elif mutation == "move-source":
                    target = self.base / "source/中文 空格.txt"
                    original = target.read_bytes()
                    target.unlink()
                    restore = lambda: target.write_bytes(original)
                elif mutation == "pollute-root1":
                    target = self.base / "root1/unexpected.txt"
                    target.write_bytes(b"wrong root")
                    restore = target.unlink
                else:
                    target = self.base / fixture.EMPTY_DIR
                    target.rmdir()
                    restore = target.mkdir
                try:
                    with patch.object(oracle.time, "sleep") as sleep, self.assertRaisesRegex(StepError, "differ"):
                        oracle.run(self.ctx, {"state": "seeded"}, mode="native")
                    sleep.assert_not_called()
                finally:
                    restore()
        records = [json.loads(line) for line in (self.ctx.case_dir / "workspace-drop-import-observations.jsonl").read_text().splitlines()]
        self.assertTrue(all(not record["passed"] for record in records))

    def test_oracle_does_not_pass_an_initial_snapshot_before_a_delayed_invalid_write(self):
        calls = [0]
        original = oracle.host_snapshot
        def observe(base):
            calls[0] += 1
            if calls[0] == 2:
                (base / "root1/unexpected.txt").write_bytes(b"delayed incorrect import")
            return original(base)
        with patch.object(oracle, "host_snapshot", side_effect=observe), patch.object(oracle.time, "sleep"), \
                self.assertRaises(StepError):
            oracle.run(self.ctx, {"state": "seeded"}, mode="native")
        self.assertEqual(calls[0], 2)

    def test_browser_oracle_only_reads_vfs_and_never_uses_a_host_snapshot(self):
        self.manifest["base"] = "/preview/workspace-drop-import-unit"
        self.manifest["mode"] = "browser"
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.ctx.page = Mock()
        self.ctx.page.evaluate.return_value = self.manifest["states"]["seeded"]
        with patch.object(oracle, "host_snapshot") as host, patch.object(oracle.time, "monotonic", side_effect=[0, .6]):
            oracle.run(self.ctx, {"state": "seeded"}, mode="browser")
        host.assert_not_called()
        script, base = self.ctx.page.evaluate.call_args.args
        self.assertEqual(base, self.manifest["base"])
        self.assertIn("entry.fileType === 'dir'", script)
        self.assertIn("vfsReadBytes", script)
        self.assertNotIn("vfsWrite", script)
        self.assertNotIn("invoke", script)

    def test_unowned_tree_unknown_phase_mode_mismatch_and_symlink_fail(self):
        with self.assertRaises(StepError):
            oracle.run(self.ctx, {"state": "other"}, mode="native")
        self.manifest["base"] = str(self.report.parent / "unowned")
        self.manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(StepError, "outside"):
            oracle.run(self.ctx, {"state": "seeded"}, mode="native")
        self.manifest["base"] = str(self.base)
        self.manifest["mode"] = "browser"
        self.manifest_path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(StepError, "mode differs"):
            oracle.run(self.ctx, {"state": "seeded"}, mode="native")
        link = self.base / "unexpected-link"
        try:
            link.symlink_to(self.base / "source")
        except OSError:
            return  # Windows without symlink privilege; the other guards ran.
        with self.assertRaisesRegex(StepError, "symlink"):
            oracle.host_snapshot(self.base)

    def test_both_cases_have_reviewed_valid_mappings_and_resolvable_fixture_paths(self):
        for case_id, suffix, mode in [("087", "browser", "browser"), ("088", "native", "native")]:
            path = ROOT / f"qa-ui-auto-tests/cases/TC-WS-{case_id}-workspace-drop-import-{suffix}.testcase.yaml"
            case = load_case(path)
            self.assertEqual(case.modes, [mode])
            self.assertEqual(case.covers, ["F25.1", "F-WS-2"])
            self.assertEqual(validate_contract({"steps": case.steps, "verification": case.verification}, require_review=True), [])
            for step in case.steps:
                resolved = resolve(step, cfg={"app": {"base_url": "http://fixture.invalid"}}, env={}, fixture=self.ctx.values)
                self.assertNotIn("${", json.dumps(resolved))
            claimed_results = {number for req in case.verification["requirements"] for number in req["results"]}
            checks = {number for number, step in enumerate(case.steps, 1) if is_check(step)}
            # Setup waits need not be AC results; every decisive new assertion is.
            self.assertFalse({number for number in checks - claimed_results if number > 18} - {30, 39, 46, 54})
            if mode == "native":
                self.assertEqual(sum("assert_file_sha256" in step for step in case.steps), 7)
                for platform in ["Linux", "Windows", "macOS"]:
                    self.assertIsNone(native_support(case, platform))


if __name__ == "__main__":
    unittest.main()
