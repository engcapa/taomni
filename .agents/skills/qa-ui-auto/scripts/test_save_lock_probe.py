"""Probe faults must release real readers and never reach files outside the report."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from qa_ui_auto import save_lock_probe
from qa_ui_auto.steps import StepError


class SaveLockProbeTest(TestCase):
    def test_non_windows_cannot_claim_real_sharing_evidence(self):
        with patch.object(save_lock_probe.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(StepError, "Windows sharing"):
                save_lock_probe.run(None, {})

    def test_fault_releases_the_reader_and_retains_the_original_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            # Windows temp paths may use an 8.3 alias. Match the probe's
            # canonical target when tracking the actual reader lifetimes.
            root = Path(directory).resolve()
            case = root / "runs" / "run-1" / "case"
            case.mkdir(parents=True)
            path = root / "document.txt"
            path.write_bytes(b"original complete bytes")
            readers = []
            original_open = Path.open

            def track_open(target, *args, **kwargs):
                stream = original_open(target, *args, **kwargs)
                if target == path and kwargs.get("mode", args[0] if args else None) == "rb":
                    readers.append(stream)
                return stream

            class Session:
                def focus(self, _selector):
                    pass

                def press_combo(self, _combo):
                    raise RuntimeError("original shortcut failure")

            ctx = SimpleNamespace(case_dir=case, session=Session())
            with patch.object(save_lock_probe.platform, "system", return_value="Windows"), \
                 patch.object(Path, "open", track_open):
                with self.assertRaisesRegex(RuntimeError, "original shortcut failure"):
                    save_lock_probe.run(ctx, {"path": str(path), "selector": ".editor",
                                              "equals": "0" * 64, "max_ui_ms": 1500})
            self.assertGreaterEqual(len(readers), 2)
            self.assertTrue(all(stream.closed for stream in readers))
            self.assertEqual(path.read_bytes(), b"original complete bytes")
            record = json.loads((case / "native-save-reader-lock.json").read_text())
            self.assertEqual(record["error"], "original shortcut failure")
            self.assertNotIn("passed", record)

    def test_external_path_and_indistinguishable_budget_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            case = root / "reports" / "runs" / "run-1" / "case"
            case.mkdir(parents=True)
            outside = root / "personal-file.txt"
            outside.write_bytes(b"never lock this")
            inside = root / "reports" / "document.txt"
            inside.write_bytes(b"fixture")
            ctx = SimpleNamespace(case_dir=case, session=None)
            with patch.object(save_lock_probe.platform, "system", return_value="Windows"):
                for path, limit, error in [(outside, 1500, "report root"), (inside, 2000, "2s lock timeout")]:
                    with self.subTest(path=path), self.assertRaisesRegex(StepError, error):
                        save_lock_probe.run(ctx, {"path": str(path), "selector": ".editor",
                                                  "equals": "0" * 64, "max_ui_ms": limit})
            self.assertEqual(outside.read_bytes(), b"never lock this")
