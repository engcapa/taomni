"""Pure contracts for monitoring hosted shards through the logged-in gh CLI."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, call, patch
import xml.etree.ElementTree as ET

from ci_live_monitor import discover_selection, main
from ci_live_shards import GitHubArtifacts, collect, report_shard
from qa_ui_auto.reporter import write_junit


class ShardReportTests(unittest.TestCase):
    def test_terminal_escapes_do_not_break_junit_or_hide_the_case_failure(self):
        message = "\x1b[31;1mPowerShell could not open a chooser\x1b[0m"
        case = {"id": "TC-X", "title": "Save", "status": "failed", "failure": {"message": message}}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            junit = write_junit(path, {"cases": [case]})
            failure = ET.parse(junit).find(".//failure")
            self.assertIn("PowerShell could not open a chooser", failure.text)
            self.assertEqual(case["failure"]["message"], message)

            junit.write_text(f'<testcase name="{message}"></testcase>', encoding="utf-8")
            (path / "summary.json").write_text(json.dumps({"cases": [case]}), encoding="utf-8")
            with redirect_stdout(io.StringIO()) as logs:
                report_shard(path, None)
            self.assertIn("TC-X Save: failed", logs.getvalue())
            self.assertIn(message, junit.read_text(encoding="utf-8"))


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def sleep(self, duration):
        self.now += duration


class GitHubListingTests(unittest.TestCase):
    @staticmethod
    def reply(value, etag=None):
        header = b"HTTP/2.0 200 OK\n"
        if etag:
            header += f"ETag: {etag}\r\n".encode("ascii")
        header += b"Content-Type: application/json\r\n\r\n"
        return subprocess.CompletedProcess([], 0, header + json.dumps(value).encode("utf-8"))

    def test_paginated_listing_does_not_require_a_newer_gh_slurp_option(self):
        pages = [{"artifacts": [{"id": n} for n in range(100)]},
                 {"artifacts": [{"id": 100}]}]
        replies = [self.reply(page) for page in pages]
        with patch("ci_live_shards.subprocess.run", side_effect=replies) as run:
            observed = GitHubArtifacts("engcapa/taomni", "42").listing("artifacts")
        self.assertEqual([item["id"] for item in observed], list(range(101)))
        self.assertEqual(run.call_count, 2)
        for page, call in enumerate(run.call_args_list, start=1):
            self.assertEqual(call.args[0], ["gh", "api", "--include",
                f"repos/engcapa/taomni/actions/runs/42/artifacts?per_page=100&page={page}"])

    def test_unchanged_artifacts_reuse_the_page_until_a_new_shard_arrives(self):
        first = {"artifacts": [{"id": 1}]}
        second = {"artifacts": [{"id": 1}, {"id": 2}]}
        unchanged = subprocess.CompletedProcess([], 1, b"HTTP/2.0 304 Not Modified\n\n")
        client = GitHubArtifacts("engcapa/taomni", "42")
        with patch("ci_live_shards.subprocess.run", side_effect=[
            self.reply(first, '"revision-1"'), unchanged, self.reply(second, '"revision-2"'), unchanged,
        ]) as run:
            self.assertEqual(client.listing("artifacts"), first["artifacts"])
            self.assertEqual(client.listing("artifacts"), first["artifacts"])
            self.assertEqual(client.listing("artifacts"), second["artifacts"])
            self.assertEqual(client.listing("artifacts"), second["artifacts"])
        self.assertEqual(run.call_args_list[1].args[0][-2:], ["--header", 'If-None-Match: "revision-1"'])
        self.assertEqual(run.call_args_list[3].args[0][-2:], ["--header", 'If-None-Match: "revision-2"'])

    def test_listing_failure_is_reported_instead_of_an_empty_success(self):
        with patch("ci_live_shards.subprocess.run", side_effect=subprocess.CalledProcessError(1, "gh")):
            with self.assertRaises(subprocess.CalledProcessError):
                GitHubArtifacts("engcapa/taomni", "42").listing("jobs")


class SelectionDiscoveryTests(unittest.TestCase):
    def discover(self, client, timeout=60):
        clock = Clock()
        return discover_selection(client, timeout, sleep=clock.sleep, monotonic=clock.monotonic)

    def test_waits_for_planning_and_retries_a_proxy_failure(self):
        client = Mock()
        client.listing.side_effect = [[], subprocess.CalledProcessError(1, "gh"),
            [{"name": "qa-selection-current", "expired": False}]]
        client.run_status.return_value = "in_progress"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.discover(client), "current")
        self.assertEqual(client.listing.call_count, 3)
        client.run_status.assert_called_once_with()

    def test_multiple_invocations_require_explicit_selection(self):
        client = Mock()
        client.listing.return_value = [{"name": f"qa-selection-{key}"} for key in ("first", "second")]
        with self.assertRaisesRegex(RuntimeError, "--artifact-key"):
            self.discover(client)

    def test_planner_checks_artifacts_more_often_than_workflow_status(self):
        client = Mock()
        client.listing.side_effect = [[], [], [], [{"name": "qa-selection-current"}]]
        client.run_status.return_value = "queued"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.discover(client), "current")
        self.assertEqual(client.listing.call_args_list, [call("artifacts")] * 4)
        client.run_status.assert_called_once_with()

    def test_terminal_or_expired_missing_selection_is_not_success(self):
        client = Mock()
        client.listing.return_value = [{"name": "qa-selection-expired", "expired": True}]
        client.run_status.return_value = "completed"
        with self.assertRaisesRegex(RuntimeError, "completed without"):
            self.discover(client)
        client.run_status.return_value = "in_progress"
        with redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError):
            self.discover(client, timeout=20)


class MonitorCommandTests(unittest.TestCase):
    def test_discovers_selection_and_passes_the_remaining_budget(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch("ci_live_monitor.GitHubArtifacts") as client, \
             patch("ci_live_monitor.discover_selection", return_value="selected") as discover, \
             patch("ci_live_monitor.collect", return_value=0) as collector, \
             patch("ci_live_monitor.time.monotonic", side_effect=[10, 25]):
            destination = Path(directory) / "reports"
            self.assertEqual(main(["--run-id", "42", "--repository", "owner/repo",
                "--destination", str(destination), "--timeout-seconds", "60"]), 0)
            client.assert_called_once_with("owner/repo", "42")
            discover.assert_called_once_with(client.return_value, 70)
            collector.assert_called_once_with(client.return_value, destination, "42", "selected", timeout_seconds=45)

    def test_explicit_selection_and_missing_shard_failure_are_retained(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch("ci_live_monitor.discover_selection") as discover, \
             patch("ci_live_monitor.collect", return_value=1) as collector:
            self.assertEqual(main(["--run-id", "42", "--artifact-key", "first",
                "--destination", directory]), 1)
            discover.assert_not_called()
            self.assertEqual(collector.call_args.args[3], "first")

    def test_never_overwrites_existing_case_evidence(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch("ci_live_monitor.GitHubArtifacts") as client, \
             redirect_stdout(io.StringIO()), patch("sys.stderr", new_callable=io.StringIO):
            original = Path(directory) / "summary.json"
            original.write_text("original failed run")
            with self.assertRaises(SystemExit):
                main(["--run-id", "42", "--destination", directory])
            self.assertEqual(original.read_text(), "original failed run")
            client.assert_not_called()

    def test_owns_the_destination_while_waiting_for_the_selection(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch("ci_live_monitor.GitHubArtifacts"), \
             patch("ci_live_monitor.collect", return_value=0) as collector, \
             patch("sys.stderr", new_callable=io.StringIO):
            args = ["--run-id", "42", "--destination", directory]

            def planning(*_):
                claim = Path(directory) / ".qa-live-monitor"
                original = claim.read_bytes()
                with self.assertRaises(SystemExit):
                    main(args)
                self.assertEqual(claim.read_bytes(), original)
                return "selected"

            with patch("ci_live_monitor.discover_selection", side_effect=planning):
                self.assertEqual(main(args), 0)
            collector.assert_called_once()


class LiveCollectionTests(unittest.TestCase):
    def test_collects_browser_before_native_producer_finishes_and_reports_actual_failure(self):
        clock = Clock()
        client = Mock()
        round_number = 0
        downloaded = []
        entries = [{"id": "linux-browser-shard-1", "mode": "browser", "platform_key": "linux"},
                   {"id": "macos-native-shard-1", "mode": "native", "platform_key": "macos",
                    "build_id": "native-build-macos-arm64-release"}]
        names = ["qa-selection-key", "qa-linux-browser-shard-1-key", "qa-macos-native-shard-1-key"]

        def listing(resource):
            nonlocal round_number
            if resource == "jobs":
                return [{"name": "build-macos / native-build-macos-arm64-release", "status": "in_progress"}]
            round_number += 1
            available = 3 if round_number >= 4 else min(round_number, 2)
            return [{"id": index, "name": name} for index, name in enumerate(names[:available])]

        def download(artifact, target):
            downloaded.append((artifact["name"], round_number))
            target.mkdir()
            if artifact["name"] == names[0]:
                (target / "selection.json").write_text(json.dumps({"entries": entries}))
            else:
                failure = '<failure message="original failure" />' if artifact["name"] == names[2] else ""
                (target / "junit.xml").write_text(f'<testsuite><testcase name="actual case">{failure}</testcase></testsuite>')

        client.listing.side_effect = listing
        client.download.side_effect = download
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(io.StringIO()) as output:
            destination = Path(directory)
            self.assertEqual(collect(client, destination, "42", "key", sleep=clock.sleep,
                monotonic=clock.monotonic), 0)
            index = json.loads((destination / "live-shard-index.json").read_text())
            self.assertEqual(index["missing_shards"], [])
            self.assertFalse(index["timed_out"])
            self.assertIn("actual case: failed", output.getvalue())
            self.assertIn("actual case: passed", output.getvalue())
        self.assertEqual(downloaded, [(names[0], 1), (names[1], 2), (names[2], 4)])
        self.assertEqual(client.listing.call_args_list.count(call("jobs")), 1)
        client.run_status.assert_not_called()  # Finished shards do not wait for the run/summary.


if __name__ == "__main__":
    unittest.main()
