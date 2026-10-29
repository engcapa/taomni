import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.file_open_probe import review, run, validate
from qa_ui_auto.steps import StepError
from qa_ui_auto.fixtures.workspace_language_files import JSON_DOCUMENT
from qa_ui_auto.fixtures.workspace_json_documents import LONG_JSON_DOCUMENT
from qa_ui_auto.file_open_profile import capture


def observation():
    return {"started": 1, "finished": True, "firstContentMs": 20,
            "firstHighlightMs": 40, "frames": [{"gapMs": 20, "matches": True, "highlighted": True}]}


CONFIG = {"selector": "[data-path='records.json']", "event": "dblclick", "label": "cold-json", "expected": JSON_DOCUMENT}


class FileOpenReviewTests(unittest.TestCase):
    def setUp(self):
        reveal = patch("qa_ui_auto.file_open_probe.reveal_tab", return_value=[])
        self.reveal = reveal.start()
        self.addCleanup(reveal.stop)

    def test_complete_sample(self):
        review(observation())

    def test_approved_frame_tolerance_keeps_every_raw_frame_and_exact_boundary(self):
        state = observation()
        for gap in [150, 150.0000000000009, 153.3, 165]:
            state["frames"].append({"gapMs": gap, "matches": True, "highlighted": True})
        original = json.dumps(state)
        review(state)
        self.assertEqual(json.dumps(state), original)
        for gap in [165.000001, float("inf"), float("nan"), -1, True]:
            with self.subTest(gap=gap), self.assertRaisesRegex(StepError, "165ms"):
                review({**state, "frames": [*state["frames"], {"gapMs": gap}]})

    def test_reuse_requires_the_actual_existing_editor_throughout_activation(self):
        review({**observation(), "editorReused": True}, require_editor_reuse=True)
        for value in [None, False, 1]:
            with self.subTest(value=value), self.assertRaisesRegex(StepError, "existing editor"):
                review({**observation(), "editorReused": value}, require_editor_reuse=True)
        with self.assertRaises(StepError):
            validate({**CONFIG, "require_editor_reuse": "true"})

    def test_plain_document_requires_exact_content_and_keeps_every_frame_budget(self):
        plain = {**observation(), "firstHighlightMs": None,
                 "frames": [{"gapMs": 20, "matches": True, "highlighted": False}]}
        review(plain, require_highlight=False)
        with self.assertRaises(StepError):
            review(plain)
        for patch in [{"firstContentMs": 1501},
                      {"frames": [{"gapMs": 165.01, "matches": True, "highlighted": False}]},
                      {"frames": [{"gapMs": 20, "matches": False, "highlighted": False}]}]:
            with self.subTest(patch=patch), self.assertRaises(StepError):
                review({**plain, **patch}, require_highlight=False)

    def test_rejects_missing_or_late_results_and_slow_frames(self):
        for patch in [{"started": None}, {"finished": False}, {"firstContentMs": 1501},
                      {"firstHighlightMs": 1501}, {"firstContentMs": float("nan")},
                      {"frames": []}, {"frames": [{"gapMs": 165.01, "matches": True, "highlighted": True}]},
                      {"frames": [{"gapMs": 20, "matches": False, "highlighted": True}]}]:
            with self.subTest(patch=patch), self.assertRaises(StepError):
                review({**observation(), **patch})

    def test_validates_args_and_artifact_path(self):
        self.assertEqual(validate(CONFIG), CONFIG)
        self.assertFalse(validate({**CONFIG, "require_highlight": False})["require_highlight"])
        for patch in [{"label": "../other"}, {"event": "input"}, {"expected": ""}, {"selector": None},
                      {"budget": 9999}, {"require_highlight": 0}, {"require_highlight": "false"}]:
            with self.subTest(patch=patch), self.assertRaises(StepError):
                validate({**CONFIG, **patch})

    def test_public_fixture_has_no_secrets_and_preserves_full_document(self):
        data = json.loads(JSON_DOCUMENT)
        self.assertEqual(len(JSON_DOCUMENT.splitlines()), 704)
        self.assertEqual(len(data["records"]), 100)
        self.assertEqual(data["records"][-1]["name"], "Public fixture 099")
        self.assertEqual(set(data["records"][0]), {"id", "name", "enabled", "description", "category"})

    def test_long_line_fixture_retains_the_reported_workload_dimensions(self):
        document = json.loads(LONG_JSON_DOCUMENT)
        self.assertEqual(len(LONG_JSON_DOCUMENT.splitlines()), 693)
        self.assertGreaterEqual(len(LONG_JSON_DOCUMENT.encode("utf-8")), 190_000)
        self.assertLessEqual(len(LONG_JSON_DOCUMENT.encode("utf-8")), 210_000)
        self.assertGreaterEqual(max(map(len, LONG_JSON_DOCUMENT.splitlines())), 5125)
        self.assertEqual(len(document["records"]), 40)
        self.assertTrue(all(record["label"].startswith("Public synthetic") for record in document["records"]))

    def test_native_action_and_cleanup_have_no_document_writes(self):
        session = Mock()
        session.execute.side_effect = [True, observation(), observation()]
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(session=session, case_dir=Path(folder))
            run(ctx, CONFIG)
            report = json.loads((Path(folder) / "file-open-cold-json.json").read_text())
        self.assertTrue(report["passed"])
        self.assertEqual(report["openBudgetMs"], 1500)
        self.assertEqual(report["frameBudgetMs"], 150)
        self.assertEqual(report["frameTolerancePercent"], 10)
        self.assertEqual(report["frameLimitMs"], 165)
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
            trace = {"started": True, "screenshots": False, "snapshots": False, "sources": False}
            run(SimpleNamespace(page=page, case_dir=Path(folder), case_state={"browser_trace": trace}), {**CONFIG, "event": "click"})
            report = json.loads((Path(folder) / "file-open-cold-json.json").read_text())
        self.assertEqual(report["browserTrace"], trace)
        page.locator(CONFIG["selector"]).click.assert_called_once_with()

    def test_native_plaintext_does_not_fabricate_highlighting(self):
        session = Mock()
        plain = {**observation(), "firstHighlightMs": None,
                 "frames": [{"gapMs": 20, "matches": True, "highlighted": False}]}
        session.execute.side_effect = [True, plain, plain]
        with tempfile.TemporaryDirectory() as folder:
            run(SimpleNamespace(session=session, case_dir=Path(folder)),
                {**CONFIG, "expected": "Plain document\n", "require_highlight": False})
            report = json.loads((Path(folder) / "file-open-cold-json.json").read_text())
        self.assertTrue(report["passed"])
        self.assertFalse(report["requireHighlight"])
        self.assertIsNone(report["observation"]["firstHighlightMs"])
        session.dblclick.assert_called_once_with(CONFIG["selector"])

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
