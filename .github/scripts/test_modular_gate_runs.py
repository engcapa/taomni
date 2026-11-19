"""Regression tests for the GitHub workflow dispatch lookup."""

import subprocess
import unittest
from unittest.mock import call, patch

from modular_gate_runs import api


class GitHubRunLookupTests(unittest.TestCase):
    def test_new_run_can_be_missing_after_dispatch(self):
        command = ["gh", "api", "repos/engcapa/taomni/actions/runs/123"]
        missing = subprocess.CompletedProcess(command, 1, "", "gh: Not Found (HTTP 404)\n")
        available = subprocess.CompletedProcess(command, 0, '{"head_sha": "source-sha"}', "")
        with patch("modular_gate_runs.subprocess.run", side_effect=[missing, missing, available]) as run:
            with patch("modular_gate_runs.time.sleep") as sleep:
                self.assertEqual(api("engcapa/taomni", "actions/runs/123", retry_missing=True),
                                 {"head_sha": "source-sha"})
        self.assertEqual([args.args[0] for args in run.call_args_list], [command] * 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    def test_missing_run_fails_after_the_lookup_budget(self):
        missing = subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)\n")
        with patch("modular_gate_runs.subprocess.run", return_value=missing) as run:
            with patch("modular_gate_runs.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, r"actions/runs/123.*HTTP 404"):
                    api("engcapa/taomni", "actions/runs/123", retry_missing=True)
        self.assertEqual(run.call_count, 6)

    def test_only_a_missing_child_read_can_retry(self):
        for body, failure in ((None, "HTTP 403"), ({"ref": "main"}, "HTTP 404")):
            with self.subTest(body=body, failure=failure):
                result = subprocess.CompletedProcess([], 1, "", f"gh: Request failed ({failure})\n")
                with patch("modular_gate_runs.subprocess.run", return_value=result) as run:
                    with self.assertRaisesRegex(RuntimeError, failure):
                        api("engcapa/taomni", "some-endpoint", body=body, retry_missing=True)
                run.assert_called_once()
