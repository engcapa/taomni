from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import run_native_step
from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.assertions import step_eval_readonly


class ReadonlyStepsTest(TestCase):
    def run_check(self, mode, values, **args):
        ctx = Mock()
        evaluate = ctx.page.evaluate if mode == "browser" else ctx.session.execute
        evaluate.side_effect = values
        if mode == "browser":
            context = StepContext(ctx.page, "TC-readonly", Path("."), {}, {})
            step_eval_readonly(context, {"expression": "document.body.clientWidth > 0", **args})
        else:
            run_native_step(ctx, "eval_readonly", {"expression": "document.body.clientWidth > 0", **args})
        return evaluate

    def test_waits_for_async_layout_without_changing_the_page(self):
        for mode in ("browser", "native"):
            with self.subTest(mode=mode), patch("qa_ui_auto.deadline.budget_time.sleep"):
                evaluate = self.run_check(mode, [False, True], timeout_sec=1)
                self.assertEqual(evaluate.call_count, 2)

    def test_existing_assertions_still_fail_immediately(self):
        for mode in ("browser", "native"):
            with self.subTest(mode=mode), self.assertRaisesRegex(StepError, "returned falsy"):
                self.run_check(mode, [False, True])

    def test_timeout_preserves_failure_for_a_persistent_layout_problem(self):
        for mode in ("browser", "native"):
            with self.subTest(mode=mode), \
                 patch("qa_ui_auto.deadline.budget_time.time", side_effect=[0, 2]), \
                 self.assertRaisesRegex(StepError, "returned falsy"):
                self.run_check(mode, [False], timeout_sec=1)

    def test_contains_must_match_even_when_truthiness_is_disabled(self):
        for mode in ("browser", "native"):
            with self.subTest(mode=mode), patch("qa_ui_auto.deadline.budget_time.sleep"):
                evaluate = self.run_check(mode, ["old", "ready"], expect_truthy=False,
                                          contains="ready", timeout_sec=1)
                self.assertEqual(evaluate.call_count, 2)

    def test_polling_does_not_bypass_readonly_validation(self):
        ctx = StepContext(Mock(), "TC-readonly", Path("."), {}, {})
        with self.assertRaisesRegex(StepError, "forbidden pattern"):
            step_eval_readonly(ctx, {"expression": "document.body.click()", "timeout_sec": 1})
        ctx.page.evaluate.assert_not_called()
