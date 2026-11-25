from base64 import b64decode
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from qa_ui_auto.fixtures import REGISTRY, module_offline_archive


class ModuleOfflineArchiveTests(unittest.TestCase):
    def test_fixture_is_report_scoped_untrusted_and_isolated_per_invocation(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory)
            ctx = SimpleNamespace(case_dir=report / "TC-unit", values={})
            module_offline_archive.setup(ctx)
            archive = Path(ctx.values["module_untrusted_archive"])
            self.assertTrue(archive.is_relative_to(report))
            self.assertTrue(archive.is_file())
            self.assertFalse(archive.is_symlink())
            signature = ctx.values["module_untrusted_signature"].splitlines()
            self.assertEqual(b64decode(signature[1]), b"ED" + bytes(8) + bytes(64))
            self.assertEqual(b64decode(signature[3]), bytes(64))
            module_offline_archive.setup(ctx)
            self.assertNotEqual(archive, Path(ctx.values["module_untrusted_archive"]))
            self.assertTrue(archive.exists(), "failed inputs remain retained as evidence")
            self.assertIs(REGISTRY["module_offline_archive"].setup, module_offline_archive.setup)


if __name__ == "__main__":
    unittest.main()
