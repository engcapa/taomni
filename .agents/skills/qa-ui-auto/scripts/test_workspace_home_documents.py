from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import json
from unittest.mock import patch

from qa_ui_auto.fixtures import workspace_home_documents as fixture
from qa_ui_auto.fixtures import workspace_home_git_documents as git_fixture


class HomeFixtureOwnershipTests(unittest.TestCase):
    def test_public_copy_and_cleanup_leave_all_other_home_files_untouched(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder) / "home"
            home.mkdir()
            existing = home / "existing-personal-file.txt"
            existing.write_text("keep this file")
            seed = Path(folder) / "seed"
            (seed / "Documents").mkdir(parents=True)
            (seed / "Documents/notes.txt").write_text("public fixture")
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, values={}, case_dir=Path(folder))
            def seed_public(ctx):
                ctx.values["platform_workspace_root"] = str(seed)
            with patch.object(fixture.Path, "home", return_value=home), patch.object(
                fixture.workspace_language_files, "setup", side_effect=seed_public,
            ):
                fixture.setup(ctx)
                owned = Path(ctx.values["workspace_home_fixture_root"])
                self.assertEqual((owned / "Documents/notes.txt").read_text(), "public fixture")
                self.assertEqual((owned / "Documents/qa-public-source.py").read_text(), fixture.PUBLIC_SOURCE_TEXT)
                self.assertNotIn("_", owned.name)
                layout = json.loads(Path(ctx.values["workspace_home_layout_report"]).read_text())
                self.assertGreaterEqual(layout["fileCount"], 2900)
                self.assertGreaterEqual(layout["directoryCount"], 400)
                self.assertGreaterEqual(layout["maxDepth"], 7)
                self.assertEqual(layout["wideDocumentCount"], 320)
                self.assertEqual(layout["projectCount"], 64)
                self.assertGreaterEqual(len(layout["types"]), 18)
                for suffix in [".log", ".txt", ".md", ".json", ".java", ".ts", ".py", ".sh"]:
                    self.assertGreater(layout["types"].get(suffix, 0), 0, suffix)
                self.assertEqual(len(list((owned / "Documents").glob("public-*"))), 320)
                deep = home / ctx.values["workspace_home_deep_document"]
                self.assertEqual(deep.read_bytes(), fixture.workspace_home_layout.LONG_JSON_DOCUMENT.encode("utf-8"))
                self.assertEqual(len(list((owned / "Projects").rglob("package.json"))), 64)
                fixture.teardown(ctx)
                self.assertFalse(owned.exists())
                self.assertEqual(existing.read_text(), "keep this file")
                self.assertEqual(list(home.iterdir()), [existing])

    def test_cleanup_rejects_a_forged_home_or_profile_path(self):
        for path in [Path.home(), Path.home() / ".local/share/com.taomni.app.qa", Path("/tmp/taomni-qa-perf-fake")]:
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "unowned"):
                fixture.teardown(SimpleNamespace(values={"workspace_home_fixture_root": str(path)}))

    def test_browser_cannot_silently_replace_a_real_home_case(self):
        with self.assertRaisesRegex(RuntimeError, "native"):
            fixture.setup(SimpleNamespace(cfg={"app": {"mode": "browser"}}, values={}))

    def test_git_fixture_owns_real_tracked_and_unrelated_repositories(self):
        import subprocess
        with tempfile.TemporaryDirectory() as folder:
            owned = Path(folder)
            (owned / "Documents").mkdir()
            (owned / "Documents/notes.txt").write_text("Public initial note\n")
            ctx = SimpleNamespace(values={"workspace_home_fixture_root": str(owned)})
            with patch.object(git_fixture.workspace_home_documents, "setup"):
                git_fixture.setup(ctx)
            state = subprocess.check_output(["git", "-C", str(owned / "Documents"), "status", "--porcelain"], text=True)
            self.assertIn(" M notes.txt", state)
            self.assertEqual((owned / "Documents/notes.txt").read_text(), ctx.values["workspace_notes_text"])
            self.assertTrue((owned / "Unrelated/.git").is_dir())


if __name__ == "__main__":
    unittest.main()
