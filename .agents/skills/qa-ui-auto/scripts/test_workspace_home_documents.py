from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from qa_ui_auto.fixtures import workspace_home_documents as fixture


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
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, values={})
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


if __name__ == "__main__":
    unittest.main()
