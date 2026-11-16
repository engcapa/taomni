"""Contract checks for real-process feedback, bounded requests and approvals."""
import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto import tao_real_project_validation as validation
from qa_ui_auto.steps import StepError


class Flow:
    def __init__(self, output="Tests · Execution failedexit 1\nAssertionError: wrong persisted value"):
        self.calls = 1
        self.output = output
        self.prompts = []
        self.stages = []
        self.screenshots = []

    def read(self, script):
        return [self.output]

    def record(self, label, state, outcome="passed"):
        self.stages.append((label, state, outcome))

    def screenshot(self, label):
        self.screenshots.append(label)

    def send(self, prompt):
        self.calls += 1
        self.prompts.append(prompt)

    def reply(self, label, users, **kwargs):
        if users != self.calls:
            raise AssertionError("Repair reply must use actual user/request count")


class ProjectValidationTest(unittest.TestCase):
    def setUp(self):
        self.flow = Flow()
        self.root = Path("/isolated/task-project")
        self.allowed = {"task_repository.py", "test_task_repository.py"}
        self.attempts = []
        self.results = []
        self.test_patch = patch.object(validation, "test_project", side_effect=self.execute)
        self.approval_patch = patch.object(validation, "approve_files")
        self.test_patch.start()
        self.approvals = self.approval_patch.start()
        self.addCleanup(self.test_patch.stop)
        self.addCleanup(self.approval_patch.stop)

    def execute(self, flow, command, users, stage, **kwargs):
        flow.calls += 1
        self.assertEqual(users, flow.calls)
        self.attempts.append((command, users, stage, kwargs["minimum"]))
        result = self.results.pop(0) if self.results else None
        if result:
            raise StepError(result)

    def run_flow(self, minimum=10):
        validation.checked_tests(self.flow, self.root, "python -m unittest -v", "feature-tests", self.allowed, minimum=minimum)

    def test_success_never_starts_a_repair_or_changes_the_command(self):
        self.run_flow()
        self.assertEqual(self.attempts, [("python -m unittest -v", 2, "feature-tests", 10)])
        self.assertEqual(self.flow.prompts, [])
        self.approvals.assert_not_called()

    def test_failure_uses_actual_output_then_approves_and_runs_tests_again(self):
        self.results = ["Actual test process did not have the expected exit state", None]
        self.run_flow()
        self.assertEqual(len(self.attempts), 2)
        self.assertEqual([attempt[1] for attempt in self.attempts], [2, 4])
        self.assertEqual([attempt[3] for attempt in self.attempts], [10, 10])
        prompt = self.flow.prompts[0]
        self.assertIn(self.flow.output, prompt)
        self.assertIn("Do not delete tests, weaken assertions", prompt)
        self.assertIn("at least 10 tests", prompt)
        self.assertIn("test_task_repository.py", prompt)
        self.approvals.assert_called_once_with(self.flow, self.root, self.allowed)
        self.assertEqual(self.flow.stages[0][2], "failed")
        self.assertEqual(self.flow.stages[0][1]["exitCode"], 1)
        self.assertEqual(len(self.flow.screenshots), 1)

    def test_two_unsuccessful_repairs_exhaust_the_bound_and_keep_all_failures(self):
        self.results = ["Actual test process did not have the expected exit state"] * 3
        with self.assertRaisesRegex(StepError, "expected exit state"):
            self.run_flow()
        self.assertEqual(len(self.attempts), 3)
        self.assertEqual(len(self.flow.prompts), 2)
        self.assertEqual(self.approvals.call_count, 2)
        self.assertEqual(len(self.flow.stages), 3)
        self.assertTrue(all(stage[2] == "failed" for stage in self.flow.stages))

    def test_wrong_command_and_transport_failures_do_not_make_paid_repair_requests(self):
        for failure in ["The test proposal changed the authorized test command", "Native test process did not settle", "The provider stopped before completing test-proposal"]:
            with self.subTest(failure=failure):
                self.results = [failure]
                with self.assertRaisesRegex(StepError, failure):
                    self.run_flow()
        self.assertEqual(self.flow.prompts, [])
        self.approvals.assert_not_called()

    def test_missing_process_result_is_not_treated_as_a_model_test_failure(self):
        self.flow.output = "Waiting for approval"
        self.results = ["Actual test process did not have the expected exit state"]
        with self.assertRaises(StepError):
            self.run_flow()
        self.assertEqual(self.flow.prompts, [])

    def test_missing_runtime_or_cancelled_process_never_starts_paid_repair(self):
        for exit_code in (127, 130):
            with self.subTest(exit_code=exit_code):
                self.flow.output = f"Tests · Execution failedexit {exit_code}"
                self.results = ["Actual test process did not have the expected exit state"]
                with self.assertRaises(StepError):
                    self.run_flow()
        self.assertEqual(self.flow.prompts, [])
        self.approvals.assert_not_called()

    def test_too_few_tests_keeps_the_required_count_in_feedback_and_rerun(self):
        self.flow.output = "Tests · Completedexit 0\nRan 1 test in 0.01s\nOK"
        self.results = ["The native test process did not execute the required tests", None]
        self.run_flow(minimum=12)
        self.assertIn("at least 12 tests", self.flow.prompts[0])
        self.assertEqual([attempt[3] for attempt in self.attempts], [12, 12])
        self.assertEqual(self.flow.stages[0][1]["exitCode"], 0)

    def test_python_and_typescript_round_counts_include_additional_repairs(self):
        from qa_ui_auto import tao_real_project, tao_real_typescript

        class ProjectFlow(Flow):
            def __init__(self, ctx, scenario, maximum):
                super().__init__()
                self.calls = 0
                self.ctx, self.maximum = ctx, maximum
                self.outcome = "unit-contract"

            @contextmanager
            def evidence(self):
                yield self

            def require(self, condition, message):
                if not condition:
                    raise AssertionError(message)

            def read(self, script):
                return []

        def approve(flow, root, allowed):
            for name in allowed:
                (root / name).write_text("unit fixture")

        def positive_checkpoint(flow, root, command, stage, allowed, **kwargs):
            # A test request plus one model repair and an approved rerun.
            flow.calls += 3

        def controlled_test(flow, command, users, stage, **kwargs):
            flow.calls += 1
            self.assertEqual(users, flow.calls)

        for module in (tao_real_project, tao_real_typescript):
            with self.subTest(module=module.__name__), TemporaryDirectory() as tmp:
                flows = []

                def create_flow(ctx, scenario, maximum):
                    flow = ProjectFlow(ctx, scenario, maximum)
                    flows.append(flow)
                    return flow

                with patch.object(module, "RealFlow", side_effect=create_flow), \
                     patch.object(module, "open_workspace"), \
                     patch.object(module, "approve_files", side_effect=approve), \
                     patch.object(module, "checked_tests", side_effect=positive_checkpoint), \
                     patch.object(module, "test_project", side_effect=controlled_test):
                    module.run(SimpleNamespace(case_dir=Path(tmp)))
                self.assertEqual(flows[0].calls, 15)
                self.assertLessEqual(flows[0].calls, flows[0].maximum)


if __name__ == "__main__":
    unittest.main()
