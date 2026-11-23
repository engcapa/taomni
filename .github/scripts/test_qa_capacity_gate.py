"""Regression tests for the nightly QA capacity gate."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from qa_capacity_gate import (
    MAX_API_FAILURES,
    blocking_runs,
    fetch_runs,
    main,
)


def make_run(run_id, status="in_progress", **overrides):
    run = {
        "id": run_id,
        "status": status,
        "event": "schedule",
        "head_branch": "main",
        "created_at": "2026-11-23T11:00:00Z",
        "run_attempt": 1,
    }
    run.update(overrides)
    return run


class FetchScript:
    """Deterministic fake fetch that replays its steps and repeats the last one."""

    def __init__(self, *steps):
        if not steps:
            raise ValueError("FetchScript needs at least one step")
        self.steps = list(steps)
        self.calls = []

    def __call__(self, repository, workflow):
        self.calls.append((repository, workflow))
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if isinstance(step, Exception):
            raise step
        return step


class FakeClock:
    """Monotonic clock advanced only by the injected sleep."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class BlockingRunSelectionTests(unittest.TestCase):
    def test_only_earlier_active_runs_block(self):
        runs = [
            make_run(1000, "in_progress"),
            make_run(1001, "queued"),
            make_run(1002, "waiting"),
            make_run(1003, "requested"),
            make_run(1004, "pending"),
            make_run(1005, "completed"),
            make_run(2001, "in_progress"),
            make_run(2000, "in_progress"),
        ]
        self.assertEqual([run["id"] for run in blocking_runs(runs, 2000)],
                         [1000, 1001, 1002, 1003, 1004])

    def test_later_runs_and_unreadable_ids_are_ignored(self):
        runs = [
            make_run(2000, "in_progress"),
            make_run(2001, "queued"),
            {**make_run(500), "id": "not-a-number"},
            {**make_run(400), "id": None},
        ]
        self.assertEqual(blocking_runs(runs, 2000), [])

    def test_blockers_are_reported_in_run_id_order(self):
        runs = [make_run(1500, "queued"), make_run(1200, "in_progress")]
        self.assertEqual([run["id"] for run in blocking_runs(runs, 2000)], [1200, 1500])


class CapacityGateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "capacity-gate.json"

    def environ(self, **overrides):
        values = {
            "GITHUB_TOKEN": "test-token",
            "GITHUB_REPOSITORY": "engcapa/taomni",
            "GITHUB_RUN_ID": "2000",
            "QA_GATE_WORKFLOW": "qa-ui-auto-platforms.yml",
            "QA_GATE_MAX_WAIT_SECONDS": "1200",
            "QA_GATE_POLL_SECONDS": "30",
            "QA_GATE_OUTPUT": str(self.output),
        }
        values.update(overrides)
        return {name: str(value) for name, value in values.items()}

    def run_gate(self, steps, **overrides):
        fetch = FetchScript(*steps)
        clock = FakeClock()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(self.environ(**overrides), fetch=fetch, sleep=clock.sleep, clock=clock)
        report = json.loads(self.output.read_text(encoding="utf-8"))
        return code, fetch, clock, stdout.getvalue(), report

    def test_own_run_is_first_and_passes_without_waiting(self):
        runs = [make_run(2000), make_run(2001), make_run(1000, "completed")]
        code, fetch, clock, stdout, report = self.run_gate([runs])
        self.assertEqual(code, 0)
        self.assertEqual(len(fetch.calls), 1)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(report["outcome"], "clear")
        self.assertEqual(report["waited_seconds"], 0)
        self.assertEqual(report["blocking"], [])
        self.assertNotIn("::warning::", stdout)

    def test_earlier_active_run_is_awaited_until_it_finishes(self):
        blockers = [make_run(1500, "in_progress"), make_run(1400, "queued")]
        finished = [make_run(1500, "completed"), make_run(1400, "completed")]
        code, fetch, clock, stdout, report = self.run_gate([blockers, blockers, finished])
        self.assertEqual(code, 0)
        self.assertEqual(len(fetch.calls), 3)
        self.assertEqual(clock.sleeps, [30, 30])
        self.assertEqual(report["outcome"], "clear")
        self.assertEqual(report["waited_seconds"], 60)
        for expected in ("run 1400", "run 1500", "status=in_progress", "head_branch=main",
                         "created_at=2026-11-23T11:00:00Z"):
            self.assertIn(expected, stdout)
        self.assertNotIn("::warning::", stdout)

    def test_later_created_run_does_not_block(self):
        runs = [make_run(1999, "completed"), make_run(2001, "in_progress"), make_run(2002, "queued")]
        code, fetch, clock, stdout, report = self.run_gate([runs])
        self.assertEqual(code, 0)
        self.assertEqual(len(fetch.calls), 1)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(report["outcome"], "clear")
        self.assertEqual(report["blocking"], [])

    def test_wait_limit_fails_open_with_a_timeout_outcome(self):
        blockers = [make_run(1200, "in_progress")]
        code, fetch, clock, stdout, report = self.run_gate(
            [blockers], QA_GATE_MAX_WAIT_SECONDS="60", QA_GATE_POLL_SECONDS="20")
        self.assertEqual(code, 0)
        self.assertEqual(report["outcome"], "timeout")
        self.assertEqual(report["waited_seconds"], 60)
        self.assertEqual([run["id"] for run in report["blocking"]], [1200])
        self.assertEqual(len(fetch.calls), 4)
        self.assertEqual(clock.sleeps, [20, 20, 20])
        self.assertIn("::warning::", stdout)
        self.assertIn("timed out", stdout)

    def test_repeated_api_failures_fail_open_with_an_api_error_outcome(self):
        code, fetch, clock, stdout, report = self.run_gate(
            [RuntimeError("gh: HTTP 502")], QA_GATE_MAX_WAIT_SECONDS="1200", QA_GATE_POLL_SECONDS="5")
        self.assertEqual(code, 0)
        self.assertEqual(report["outcome"], "api-error")
        self.assertEqual(report["waited_seconds"], 10)
        self.assertEqual(len(fetch.calls), MAX_API_FAILURES)
        self.assertEqual(clock.sleeps, [5, 5])
        self.assertIn("::warning::", stdout)
        self.assertIn("HTTP 502", stdout)

    def test_transient_api_failure_recovers_on_the_next_poll(self):
        code, fetch, clock, stdout, report = self.run_gate(
            [RuntimeError("gh: HTTP 500"), []], QA_GATE_POLL_SECONDS="5")
        self.assertEqual(code, 0)
        self.assertEqual(len(fetch.calls), 2)
        self.assertEqual(clock.sleeps, [5])
        self.assertEqual(report["outcome"], "clear")
        self.assertNotIn("::warning::", stdout)

    def test_optional_settings_fall_back_to_the_nightly_defaults(self):
        environment = {
            "GITHUB_TOKEN": "test-token",
            "GITHUB_REPOSITORY": "engcapa/taomni",
            "GITHUB_RUN_ID": "2000",
            "QA_GATE_OUTPUT": str(self.output),
        }
        fetch = FetchScript(RuntimeError("gh: HTTP 503"), [])
        clock = FakeClock()
        with contextlib.redirect_stdout(io.StringIO()):
            code = main(environment, fetch=fetch, sleep=clock.sleep, clock=clock)
        report = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(clock.sleeps, [30])
        self.assertEqual(report["workflow"], "qa-ui-auto-platforms.yml")
        self.assertEqual(report["outcome"], "clear")

    def test_report_records_the_gate_contract(self):
        blocker = make_run(1300, "in_progress", event="workflow_dispatch",
                           head_branch="feature/qa", run_attempt=2)
        code, _, _, _, report = self.run_gate(
            [[blocker]], QA_GATE_MAX_WAIT_SECONDS="10", QA_GATE_POLL_SECONDS="10")
        self.assertEqual(code, 0)
        self.assertEqual(set(report), {"own_run_id", "workflow", "waited_seconds", "blocking", "outcome"})
        self.assertEqual(report["own_run_id"], 2000)
        self.assertEqual(report["workflow"], "qa-ui-auto-platforms.yml")
        self.assertEqual(report["outcome"], "timeout")
        self.assertEqual(report["waited_seconds"], 10)
        self.assertEqual(report["blocking"], [{
            "id": 1300,
            "status": "in_progress",
            "event": "workflow_dispatch",
            "head_branch": "feature/qa",
            "created_at": "2026-11-23T11:00:00Z",
            "run_attempt": 2,
        }])


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "capacity-gate.json"

    def environ(self, **overrides):
        values = {
            "GITHUB_REPOSITORY": "engcapa/taomni",
            "GITHUB_RUN_ID": "2000",
            "QA_GATE_OUTPUT": str(self.output),
        }
        values.update(overrides)
        return {name: str(value) for name, value in values.items()}

    def invalid(self, **overrides):
        fetch = FetchScript([[]])
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(self.environ(**overrides), fetch=fetch, sleep=lambda _: None, clock=lambda: 0.0)
        self.assertEqual(code, 2)
        self.assertEqual(fetch.calls, [])
        self.assertFalse(self.output.exists())
        return stdout.getvalue()

    def test_non_numeric_run_id_fails_with_exit_code_two(self):
        self.assertIn("GITHUB_RUN_ID", self.invalid(GITHUB_RUN_ID="not-a-number"))

    def test_invalid_settings_fail_before_any_api_request(self):
        for overrides in (
            {"GITHUB_RUN_ID": "0"},
            {"GITHUB_REPOSITORY": "taomni"},
            {"QA_GATE_POLL_SECONDS": "0"},
            {"QA_GATE_MAX_WAIT_SECONDS": "-1"},
            {"QA_GATE_MAX_WAIT_SECONDS": "soon"},
            {"QA_GATE_WORKFLOW": "../qa-ui-auto-platforms.yml"},
        ):
            with self.subTest(overrides=overrides):
                self.invalid(**overrides)


class FetchRunsTests(unittest.TestCase):
    def test_fetch_reads_one_unfiltered_page_of_workflow_runs(self):
        payload = {"total_count": 1, "workflow_runs": [make_run(1500)]}
        completed = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with patch("qa_capacity_gate.subprocess.run", return_value=completed) as run:
            runs = fetch_runs("engcapa/taomni", "qa-ui-auto-platforms.yml")
        self.assertEqual(runs, [make_run(1500)])
        self.assertEqual(run.call_args.args[0], [
            "gh", "api",
            "repos/engcapa/taomni/actions/workflows/qa-ui-auto-platforms.yml/runs?per_page=50",
        ])
        self.assertEqual(run.call_args.kwargs["timeout"], 45)

    def test_fetch_failure_raises_with_the_api_error(self):
        completed = subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)\n")
        with patch("qa_capacity_gate.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
                fetch_runs("engcapa/taomni", "qa-ui-auto-platforms.yml")

    def test_fetch_rejects_a_response_without_a_run_list(self):
        completed = subprocess.CompletedProcess([], 0, '{"total_count": 0}', "")
        with patch("qa_capacity_gate.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "workflow_runs"):
                fetch_runs("engcapa/taomni", "qa-ui-auto-platforms.yml")


if __name__ == "__main__":
    unittest.main()
