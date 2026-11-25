"""The data oracle detects missing bytes, forged locators and false UI status."""
import json
from pathlib import Path
import tempfile
import unittest

from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.module_retained_observation import DATA_BYTES, DATA_NAME, observe
from qa_ui_auto.steps import StepError


class ModuleRetainedObservationTests(unittest.TestCase):
    def seed(self, directory):
        root = Path(directory).resolve() / "plugins"
        (root / "hello-plugin").mkdir(parents=True)
        observe(root, "seed-data", {"state": "installed"})
        return root

    def test_fixture_is_not_an_assertion_and_cannot_overwrite_existing_data(self):
        self.assertFalse(is_check({"module_signed_probe": {"phase": "seed-data"}}))
        for phase in ("retained", "installed-data", "deleted"):
            self.assertTrue(is_check({"module_signed_probe": {"phase": phase}}))
        with tempfile.TemporaryDirectory() as directory:
            root = self.seed(directory)
            self.assertEqual((root / "hello-plugin/data" / DATA_NAME).read_bytes(), DATA_BYTES)
            with self.assertRaises(FileExistsError):
                observe(root, "seed-data", {})
            observe(root, "installed-data", {})
            (root / "hello-plugin/data" / DATA_NAME).write_bytes(b"changed")
            with self.assertRaisesRegex(StepError, "business bytes"):
                observe(root, "installed-data", {})

    def test_retained_requires_exact_locator_original_bytes_and_native_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.seed(directory)
            control = root / ".retained-data"
            control.mkdir()
            locator = control / "hello-plugin.json"
            expected = {"formatVersion": 1, "slug": "hello-plugin", "dataSchemaVersion": 1,
                        "files": [{"path": DATA_NAME, "kind": "file"}]}
            locator.write_text(json.dumps(expected))
            observe(root, "retained", {"dataRetained": True})
            with self.assertRaisesRegex(StepError, "registry lost"):
                observe(root, "retained", {"dataRetained": False})
            locator.write_text(json.dumps({**expected, "commands": ["execute"]}))
            with self.assertRaisesRegex(StepError, "locator differs"):
                observe(root, "retained", {"dataRetained": True})

    def test_explicit_delete_requires_both_absent_and_an_honest_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.seed(directory)
            with self.assertRaisesRegex(StepError, "left data"):
                observe(root, "deleted", {"dataRetained": False})
            (root / "hello-plugin/data" / DATA_NAME).unlink()
            (root / "hello-plugin/data").rmdir()
            with self.assertRaisesRegex(StepError, "incorrectly reports"):
                observe(root, "deleted", {"dataRetained": True})
            observe(root, "deleted", {"dataRetained": False})
            control = root / ".retained-data"
            control.mkdir()
            (control / "hello-plugin.json").write_text("{}")
            with self.assertRaisesRegex(StepError, "left data"):
                observe(root, "deleted", {"dataRetained": False})


if __name__ == "__main__":
    unittest.main()
