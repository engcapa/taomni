import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from qa_ui_auto.file_open_probe import review, run, validate
from qa_ui_auto.steps import StepError
from qa_ui_auto.fixtures.workspace_language_files import JSON_DOCUMENT
from qa_ui_auto.file_open_profile import capture


def observation():
    return {"started": 1, "finished": True, "firstContentMs": 20,
            "firstHighlightMs": 40, "frames": [{"gapMs": 20, "matches": True, "highlighted": True}]}


CONFIG = {"selector": "[data-path='records.json']", "event": "dblclick", "label": "cold-json", "expected": JSON_DOCUMENT}


class FileOpenReviewTests(unittest.TestCase):
    def test_complete_sample(self):
        review(observation())

    def test_rejects_missing_or_late_results_and_slow_frames(self):
        for patch in [{"started": None}, {"finished": False}, {"firstContentMs": 1501},
                      {"firstHighlightMs": 1501}, {"firstContentMs": float("nan")},
                      {"frames": []}, {"frames": [{"gapMs": 151, "matches": True, "highlighted": True}]},
                      {"frames": [{"gapMs": 20, "matches": False, "highlighted": True}]}]:
            with self.subTest(patch=patch), self.assertRaises(StepError):
                review({**observation(), **patch})

    def test_validates_args_and_artifact_path(self):
        self.assertEqual(validate(CONFIG), CONFIG)
        for patch in [{"label": "../other"}, {"event": "input"}, {"expected": ""}, {"selector": None}, {"budget": 9999}]:
            with self.subTest(patch=patch), self.assertRaises(StepError):
                validate({**CONFIG, **patch})

    def test_public_fixture_has_no_secrets_and_preserves_full_document(self):
        data = json.loads(JSON_DOCUMENT)
        self.assertEqual(len(JSON_DOCUMENT.splitlines()), 704)
        self.assertEqual(len(data["records"]), 100)
        self.assertEqual(data["records"][-1]["name"], "Public fixture 099")
        self.assertEqual(set(data["records"][0]), {"id", "name", "enabled", "description", "category"})

    def test_native_action_and_cleanup_have_no_document_writes(self):
        session = Mock()
        session.execute.side_effect = [True, observation(), observation()]
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(session=session, case_dir=Path(folder))
            run(ctx, CONFIG)
            report = json.loads((Path(folder) / "file-open-cold-json.json").read_text())
        self.assertTrue(report["passed"])
        session.dblclick.assert_called_once_with(CONFIG["selector"])
        self.assertIn(".finish()", session.execute.call_args.args[0])
        session.type_text.assert_not_called()

    def test_failure_keeps_original_action_error_and_partial_frames(self):
        session = Mock()
        session.execute.side_effect = [True, {**observation(), "finished": False}]
        session.dblclick.side_effect = RuntimeError("real pointer failure")
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(session=session, case_dir=Path(folder))
            with self.assertRaisesRegex(RuntimeError, "real pointer failure"):
                run(ctx, CONFIG)
            report = json.loads((Path(folder) / "file-open-cold-json.json").read_text())
        self.assertFalse(report["passed"])
        self.assertFalse(report["observation"]["finished"])

    def test_cleanup_failure_does_not_turn_success_into_a_pass(self):
        session = Mock()
        session.execute.side_effect = [True, observation(), RuntimeError("capture failed")]
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(session=session, case_dir=Path(folder))
            with self.assertRaisesRegex(RuntimeError, "capture failed"):
                run(ctx, CONFIG)
            self.assertFalse(json.loads((Path(folder) / "file-open-cold-json.json").read_text())["passed"])

    def test_browser_uses_real_locator_activation(self):
        page = Mock()
        page.evaluate.side_effect = [True, observation(), observation()]
        with tempfile.TemporaryDirectory() as folder:
            run(SimpleNamespace(page=page, case_dir=Path(folder)), {**CONFIG, "event": "click"})
        page.locator(CONFIG["selector"]).click.assert_called_once_with()

    def test_cpu_samples_are_retained_after_the_original_action_failure(self):
        page = Mock()
        page.context.browser.browser_type.name = "chromium"
        session = page.context.new_cdp_session.return_value
        session.send.return_value = {"profile": {"nodes": [], "samples": [1, 2]}}
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "profile.json"
            with self.assertRaisesRegex(RuntimeError, "action failed"):
                with capture(page, target):
                    raise RuntimeError("action failed")
            report = json.loads(target.read_text())
        self.assertTrue(report["available"])
        self.assertEqual(report["profile"]["samples"], [1, 2])
        session.detach.assert_called_once_with()

    def test_unavailable_cpu_sampling_is_explicit_and_does_not_replace_ui_assertions(self):
        page = Mock()
        page.context.browser.browser_type.name = "webkit"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "profile.json"
            with capture(page, target):
                pass
            report = json.loads(target.read_text())
        self.assertFalse(report["available"])
        page.context.new_cdp_session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
