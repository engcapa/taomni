"""Real filesystem regression coverage for report-scoped host writes."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from qa_ui_auto.native_steps import NativeStepContext, run_native_step
from qa_ui_auto.steps import StepError


class HostWriteFileTest(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.case = self.root / "report" / "case"
        self.case.mkdir(parents=True)
        self.ctx = NativeStepContext(None, self.case, {})

    def write(self, target, text="new\ncontent"):
        return run_native_step(self.ctx, "host_write_file", {"path": str(target), "text": text})

    def test_creates_and_updates_files(self):
        target = self.case / "new.txt"
        self.write(target)
        self.assertEqual(target.read_bytes(), b"new\ncontent")
        self.write(target, "updated")
        self.assertEqual(target.read_bytes(), b"updated")

    def test_rejects_outside_targets_including_dangling_symlinks(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                outside = self.root / f"outside-{existing}.txt"
                if existing:
                    outside.write_text("original")
                link = self.case / f"link-{existing}"
                link.symlink_to(outside)
                for target in (outside, link):
                    with self.assertRaisesRegex(StepError, "inside report root"):
                        self.write(target)
                self.assertEqual(outside.exists(), existing)
                if existing:
                    self.assertEqual(outside.read_text(), "original")

    def test_resolves_parent_symlinks_and_allows_internal_symlinks(self):
        parent_link = self.case / "outside-dir"
        parent_link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(StepError, "inside report root"):
            self.write(parent_link / "escaped.txt")
        self.assertFalse((self.root / "escaped.txt").exists())
        internal = self.case / "internal-link"
        internal.symlink_to(self.case / "created.txt")
        self.write(internal)
        self.assertEqual((self.case / "created.txt").read_bytes(), b"new\ncontent")

    def test_missing_parent_is_not_created(self):
        with self.assertRaisesRegex(StepError, "cannot resolve"):
            self.write(self.case / "missing" / "file.txt")
