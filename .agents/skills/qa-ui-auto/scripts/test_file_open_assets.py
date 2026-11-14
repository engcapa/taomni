"""File-open fixture/oracle/schema contracts without launching a browser or app."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import yaml
from qa_ui_auto import file_open_observation as oracle
from qa_ui_auto.fixtures import file_open_files as fixture
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case
from qa_ui_auto.behavior_contract import validate_contract
from qa_ui_auto.verification import native_support

ROOT = Path(__file__).resolve().parents[4]


class FileOpenAssetsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.report = Path(temporary.name)
        self.ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, values={}, report_root=self.report,
                                   case_dir=self.report / "case", case_id="case", worker_id=0)
        fixture.setup(self.ctx)
        self.root = Path(self.ctx.values["file_open_root"])

    def test_fixture_seeds_exact_bytes_and_unique_workspace(self):
        self.assertEqual((self.root / "notes.txt").read_bytes(), fixture.TEXT.encode())
        self.assertEqual((self.root / "unsafe.svg").read_bytes(), fixture.SVG.encode())
        self.assertGreater((self.root / "large.txt").stat().st_size, 5 * 1024 * 1024)
        self.assertEqual(hashlib.sha256((self.root / "assets/pixel.png").read_bytes()).hexdigest(), self.ctx.values["file_open_png_sha"])
        self.assertEqual(json.loads(self.ctx.values["file_open_workspace"])["workspaces"][0]["rootFolders"][0]["path"], str(self.root))

    def test_oracle_reads_host_bytes_exactly_and_retains_failed_receipt(self):
        oracle.native(self.ctx, {"path": str(self.root / "notes.txt"), "equals": fixture.TEXT})
        (self.root / "notes.txt").write_bytes(b"changed")
        with self.assertRaisesRegex(StepError, "differ"):
            oracle.native(self.ctx, {"path": str(self.root / "notes.txt"), "equals": fixture.TEXT, "timeout_sec": 0})
        records = [json.loads(line) for line in (self.ctx.case_dir / "file-open-byte-observations.jsonl").read_text().splitlines()]
        self.assertEqual([row["passed"] for row in records], [True, False])

    def test_unowned_paths_mismatched_mode_symlinks_and_bad_postcondition_are_rejected(self):
        with self.assertRaisesRegex(StepError, "outside"):
            oracle.native(self.ctx, {"path": str(self.report / "unowned.txt"), "equals": ""})
        with self.assertRaisesRegex(StepError, "mismatched"):
            oracle.run(self.ctx, {"path": "/preview/no.txt", "equals": ""}, mode="browser")
        with self.assertRaises(StepError):
            oracle.validate({"path": "anything", "equals": "", "absent": True})
        link = self.root / "linked.txt"
        try:
            link.symlink_to(self.root / "notes.txt")
        except OSError:
            return
        with self.assertRaisesRegex(StepError, "symlink"):
            oracle.native(self.ctx, {"path": str(link), "equals": fixture.TEXT})

    def test_browser_observation_is_vfs_read_only_and_absence_uses_stat(self):
        manifest = self.ctx.case_dir / "file-open-fixture.json"
        data = json.loads(manifest.read_text())
        data.update(mode="browser", root="/preview/file-open-test")
        manifest.write_text(json.dumps(data))
        self.ctx.page = Mock()
        self.ctx.page.evaluate.return_value = {"exists": False}
        oracle.run(self.ctx, {"path": "/preview/file-open-test/gone.txt", "absent": True}, mode="browser")
        script, path = self.ctx.page.evaluate.call_args.args
        self.assertIn("vfsStat", script)
        self.assertNotIn("vfsWrite", script)
        self.assertNotIn("invoke", script)
        self.assertEqual(path, "/preview/file-open-test/gone.txt")

    def test_browser_temp_requires_observed_source_and_reuses_only_retained_path(self):
        manifest = self.ctx.case_dir / "file-open-fixture.json"
        data = json.loads(manifest.read_text())
        data.update(mode="browser", root="/preview/file-open-test")
        manifest.write_text(json.dumps(data))
        self.ctx.page = Mock()
        path = "/preview/.viewer-temp/owned/copy.txt"
        with self.assertRaisesRegex(StepError, "outside"):
            oracle.run(self.ctx, {"path": path, "absent": True}, mode="browser")
        self.ctx.page.evaluate.assert_not_called()
        self.ctx.page.locator.return_value.evaluate_all.return_value = [path]
        self.ctx.page.evaluate.return_value = {"exists": True, "bytes": [65]}
        oracle.run(self.ctx, {"selector": ".readonly-viewer", "remember": "copy", "equals": "A"}, mode="browser")
        self.ctx.page.evaluate.return_value = {"exists": False}
        oracle.run(self.ctx, {"remember": "copy", "absent": True}, mode="browser")
        self.assertEqual(self.ctx.page.evaluate.call_args.args[1], path)
        with self.assertRaisesRegex(StepError, "outside"):
            oracle.run(self.ctx, {"path": "/preview/.viewer-temp/other/copy.txt", "absent": True}, mode="browser")
        self.assertEqual(self.ctx.page.evaluate.call_count, 2)

    def test_browser_absence_never_matches_empty_content_or_empty_digest(self):
        manifest = self.ctx.case_dir / "file-open-fixture.json"
        data = json.loads(manifest.read_text())
        data.update(mode="browser", root="/preview/file-open-test")
        manifest.write_text(json.dumps(data))
        self.ctx.page = Mock()
        self.ctx.page.evaluate.return_value = {"exists": False}
        for postcondition in ({"equals": ""}, {"sha256": hashlib.sha256(b"").hexdigest()}):
            with self.subTest(postcondition=postcondition), self.assertRaisesRegex(StepError, "differ"):
                oracle.run(self.ctx, {"path": "/preview/file-open-test/gone.txt", "timeout_sec": 0, **postcondition}, mode="browser")
        records = [json.loads(line) for line in (self.ctx.case_dir / "file-open-byte-observations.jsonl").read_text().splitlines()]
        self.assertEqual([row["passed"] for row in records], [False, False])
        self.assertTrue(all(row["samples"][0]["exists"] is False for row in records))

    def test_browser_vfs_read_script_proves_absence_without_swallowing_read_errors(self):
        # Execute the exact observer script. Only its imported VFS boundary is
        # controlled; this reproduces deletion between the two asynchronous reads.
        script = r"""
import assert from "node:assert/strict";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = process.argv[1];
const path = "/preview/.viewer-temp/owned/copy.txt";
const missing = () => new Error(`Not found: ${path}`);
const notFile = () => new Error(`Not a file: ${path}`);
const file = { fileType: "file" };
const fixtures = [
  { name: "regular binary bytes", stats: [file], bytes: [0, 255, 128],
    expected: { exists: true, bytes: [0, 255, 128] }, calls: ["stat", "read"] },
  { name: "empty file exists", stats: [file], bytes: [],
    expected: { exists: true, bytes: [] }, calls: ["stat", "read"] },
  { name: "already deleted", stats: [missing()], expected: { exists: false }, calls: ["stat"] },
  { name: "deleted after first stat", stats: [file, missing()], readError: notFile(),
    expected: { exists: false }, calls: ["stat", "read", "stat"] },
  { name: "directory remains", stats: [{ fileType: "dir" }, { fileType: "dir" }],
    readError: notFile(), error: `Not a file: ${path}`, calls: ["stat", "read", "stat"] },
  { name: "file data missing", stats: [file, file], readError: notFile(),
    error: `Not a file: ${path}`, calls: ["stat", "read", "stat"] },
  { name: "initial permission error", stats: [new Error("Permission denied")],
    error: "Permission denied", calls: ["stat"] },
  { name: "read permission is not absence", stats: [file, missing()],
    readError: new Error("Permission denied"), error: "Permission denied", calls: ["stat", "read"] },
  { name: "binary read failure is not absence", stats: [file, missing()],
    readError: new Error("Invalid binary data"), error: "Invalid binary data", calls: ["stat", "read"] },
  { name: "recheck permission error", stats: [file, new Error("Permission denied")],
    readError: notFile(), error: "Permission denied", calls: ["stat", "read", "stat"] },
  { name: "not found text inside another failure", stats: [new Error("Backend not found: unavailable")],
    error: "Backend not found: unavailable", calls: ["stat"] },
  { name: "other path not found", stats: [new Error(`Not found: ${path}.other`)],
    error: `Not found: ${path}.other`, calls: ["stat"] },
  { name: "other path not a file", stats: [file, missing()],
    readError: new Error(`Not a file: ${path}.other`),
    error: `Not a file: ${path}.other`, calls: ["stat", "read"] },
  { name: "unclassified read not found", stats: [file, missing()],
    readError: missing(), error: `Not found: ${path}`, calls: ["stat", "read"] },
];
for (const fixture of fixtures) {
  const calls = [];
  const stats = [...fixture.stats];
  const context = createContext({ Error });
  const vfs = new SyntheticModule(["vfsStat", "vfsReadBytes"], function () {
    this.setExport("vfsStat", async (actual) => {
      assert.equal(actual, path, fixture.name);
      calls.push("stat");
      assert.ok(stats.length, `unexpected extra stat: ${fixture.name}`);
      const value = stats.shift();
      if (value instanceof Error) throw value;
      return value;
    });
    this.setExport("vfsReadBytes", async (actual) => {
      assert.equal(actual, path, fixture.name);
      calls.push("read");
      if (fixture.readError) throw fixture.readError;
      return Uint8Array.from(fixture.bytes).buffer;
    });
  }, { context });
  await vfs.link(() => assert.fail("unexpected VFS dependency"));
  await vfs.evaluate();
  const observer = new SourceTextModule(`export default (${source});`, {
    context,
    importModuleDynamically: async (specifier) => {
      assert.equal(specifier, "/src/stubs/localVfs.ts");
      return vfs;
    },
  });
  await observer.link(() => assert.fail("unexpected observer dependency"));
  await observer.evaluate();
  try {
    const value = await observer.namespace.default(path);
    assert.equal(fixture.error, undefined, `unexpected success: ${fixture.name}`);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), fixture.expected, fixture.name);
  } catch (error) {
    assert.notEqual(fixture.error, undefined, `unexpected error: ${fixture.name}`);
    assert.equal(error.message, fixture.error, fixture.name);
    const expectedError = [fixture.readError, ...fixture.stats].find(
      (value) => value instanceof Error && value.message === fixture.error,
    );
    assert.equal(error, expectedError, fixture.name);
  }
  assert.deepEqual(calls, fixture.calls, fixture.name);
}
"""
        result = subprocess.run(
            ["node", "--experimental-vm-modules", "--input-type=module", "-e", script, oracle.READ_VFS],
            cwd=ROOT, capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_retained_ide_crash_cases_only_add_explicit_route_setup(self):
        # Frozen semantic contracts from baseline 719109a3; independent of git
        # checkout depth/HEAD after commit. Never update these to mask a removed
        # assertion: review any intended scenario change against its source case.
        baselines = {
            "038": ("45a87f7ae2e6fe1833d889fb837b916defbe16129edfc4e9799bc6fc05b34bcb", "d8f9b24431b72e22b2cf6f15aaabc4661796fc07e9ff5e8755ca7407d897a3a2"),
            "039": ("ce45cbf34cdf02a7ae11f6c431e4f02c087945bcb6f1a4697f815d0e9384cafe", "1651be3228596f0ef7b0085247d89a38123a9f33a9ca410d9d1e19b4a9f59795"),
            "051": ("2dc223ce27527afea8d8b8b373af5101f3e663866181714cd14a71df54a8f596", "031d3de32157a30c5337dd14748c4bf9fe7a1957e9954d627d77a2f90e79004c"),
            "IDE-C8-08": ("99fe6bd20e0ce2f72e62829587574348035d73a02401cbfdc1a2387ee371bf33", "0f0b84e4c9cc956babcc4b73e5e0662af96d45e98501c546723d4e6ec17bbdce"),
            "052": ("92d8d0ce6d882cf3387a5a6502675f475f03c5cc3e135ac792fb55968d37b845", "cae2b41435d7851ddd93ff14005271d1803e40fbf117ccf566f9a4d4fc4ea00e"),
            "053": ("a8e5c3311a79f05bbf6f01dabb126e1dc1aefa12a6e83ed890b53f0db78a7fb5", "9fa9e9d9ea2f29fa8100fdab79e1b587fd7272883ad9c2d9b5358e592968699c"),
            "054": ("7bd2846b57988de30c9d72f17b128efb70a4977fd96d92a3bef89d4740ca5eaf", "4f21cd1aff5f7c5a8bd92185141b74b5db2a1d1c8a3618f4609c3fdcca40b952"),
            "055": ("34d06f15d6955a72a078e4b34fc9f3dbbf8f4adc99025f39cace2d86751d9d12", "ea87de69e273c44c9fe84f8aa94849d0f7e9db3422edd8a14ae9fb71bf987396"),
            "056": ("89a01f4c2043c516a0b7840387fa4af77c94acbc86bc4d09abb1293c869dd492", "1feaefd958e4099b44a841f19090ebb3ebe88a3b44407bd8b32a087a118bfd42"),
            "057": ("498862833a388a03fa694b4cf1e6bcd861c5ef7aaef2d4b8684b94e5fb9c80a0", "d5601a09c9af2e58949bd16274c74d4835cfbc38e37edceda2b83c8fd53c6702"),
        }
        def digest(value):
            return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        for suffix, (steps_sha, contract_sha) in baselines.items():
            pattern = "TC-IDE-C8-08-*.testcase.yaml" if suffix == "IDE-C8-08" else f"TC-WS-{suffix}-*.testcase.yaml"
            path = next((ROOT / "qa-ui-auto-tests/cases").glob(pattern))
            current = yaml.safe_load(path.read_text())
            seed = [index for index, step in enumerate(current["steps"], 1) if step.get("seed_storage", {}).get("key") == "taomni.fileOpen.preferences.v1"]
            self.assertEqual(len(seed), 1, path.name)
            index = seed[0]
            inserted = {index}
            if suffix == "IDE-C8-08":
                self.assertEqual(current["steps"][index], {"reload_window": None})
                inserted.add(index + 1)
            without_setup = [step for number, step in enumerate(current["steps"], 1) if number not in inserted]
            self.assertEqual(digest(without_setup), steps_sha, path.name)
            self.assertEqual(json.loads(current["steps"][index - 1]["seed_storage"]["value"])["associations"], {"md": "workspace", "txt": "workspace"})
            self.assertEqual(validate_contract(current), [], path.name)
            original = json.loads(json.dumps(current["verification"]["requirements"]))
            for requirement in original:
                for field in ["actions", "results"]:
                    requirement[field] = [value - sum(position < value for position in inserted) for value in requirement[field]]
                for checkpoint in requirement["checkpoints"]:
                    checkpoint["step"] -= sum(position < checkpoint["step"] for position in inserted)
            self.assertEqual(digest(original), contract_sha, path.name)

    def test_file_open_case_schemas_references_and_native_verbs(self):
        files = sorted((ROOT / "qa-ui-auto-tests/cases").glob("TC-FILE-OPEN-*.testcase.yaml"))
        self.assertEqual(len(files), 12)
        for path in files:
            document = yaml.safe_load(path.read_text())
            self.assertEqual(validate_contract(document), [], path.name)
            case = load_case(path)
            self.assertIn("crash-regression", case.tags)
            if "native" in case.modes:
                for platform in ["Linux", "Windows", "macOS"]:
                    self.assertIsNone(native_support(case, platform), (case.id, platform))


if __name__ == "__main__":
    unittest.main()
