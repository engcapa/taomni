"""Offline regressions for hosted harness request failures and safe diagnostics."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import WORKER_MARKER, FixtureError, decide
from diagnostics import request_diagnostic, worker_output_diagnostic, failure_context
from server import FixtureApplication

SECRET = "unpublished-token-abcdef"


class WorkerDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = {"mode": "worker", "run_id": "ci-run", "worker_id": "codex",
                       "marker_path": "taomni-worker-marker.txt", "marker_text": "taomni:ci-run:codex\n"}
        self.marker = WORKER_MARKER + json.dumps(self.worker)

    def test_codex_exec_command_explicitly_pins_actual_worktree_and_disables_login_shell(self):
        body = {"model": "fixture-worker", "input": [{"role": "user", "content": self.marker}],
                "tools": [{"type": "function", "name": "exec_command", "parameters": {"type": "object",
                    "properties": {"cmd": {"type": "string"}, "workdir": {"type": "string"}, "login": {"type": "boolean"}}}}]}
        result = decide(body, "openai_responses", {"codex": self.root})
        self.assertEqual(result.tool_args["workdir"], str(self.root))
        self.assertIs(result.tool_args["login"], False)
        self.assertIn("printf", result.tool_args["cmd"])
        self.assertFalse((self.root / "taomni-worker-marker.txt").exists())
        observed = request_diagnostic(body)
        self.assertEqual(observed["shell_tools"][0]["fields"], ["cmd", "login", "workdir"])

    def test_fixture_422_names_exact_missing_metadata_and_offered_shell_shape_without_secrets(self):
        app = FixtureApplication(self.root / "requests.ndjson")
        body = {"model": SECRET, "messages": [{"role": "user", "content": SECRET}],
                "tools": [{"type": "function", "function": {"name": "bash", "parameters": {
                    "type": "object", "properties": {"command": {}, "description": {}, SECRET: {}},
                    "required": ["command", SECRET]}}},
                    {"type": "function", "function": {"name": SECRET}}],
                "api_key": SECRET, SECRET: SECRET}
        reply = app.dispatch("POST", "/v1/chat/completions", body)
        self.assertEqual(reply.status, 422)
        event = app.events[0]
        self.assertEqual(event["error_code"], "metadata_missing")
        self.assertEqual(event["error_stage"], "metadata")
        self.assertEqual(event["diagnostic"]["shell_tools"], [{"name": "bash", "schema_shape": "object",
            "fields": ["command", "description"], "required": ["command"]}])
        self.assertEqual(event["diagnostic"]["other_tool_count"], 1)
        self.assertNotIn(SECRET, app.request_log.read_text())
        self.assertNotIn(SECRET, json.dumps(reply.body))

    def test_auxiliary_deepseek_title_escaped_metadata_stays_rejected_and_is_classified(self):
        app = FixtureApplication(self.root / "requests.ndjson", {"codex": self.root})
        body = {"model": "fixture-worker", "system": "Create a concise title for an AI coding-assistant session from the supplied human messages.",
                "messages": [{"role": "user", "content": "Generate the session title from this JSON array of human messages:\n"
                              + json.dumps([{"text": self.marker}])}], "tools": []}
        reply = app.dispatch("POST", "/v1/messages", body)
        self.assertEqual(reply.status, 422)
        diagnostic = app.events[0]["diagnostic"]
        self.assertIn("auxiliary_title_request", diagnostic["categories"])
        self.assertTrue(diagnostic["worker_marker_embedded"])
        self.assertFalse(diagnostic["worker_marker_line"])
        self.assertEqual(app.events[0]["error_code"], "metadata_missing")
        self.assertFalse((self.root / "taomni-worker-marker.txt").exists())

    def test_registered_worker_failure_keeps_digest_and_exact_tool_selection_stage(self):
        app = FixtureApplication(self.root / "requests.ndjson", {"codex": self.root})
        body = {"model": "fixture-worker", "messages": [{"role": "user", "content": self.marker}], "tools": []}
        self.assertEqual(app.dispatch("POST", "/v1/chat/completions", body).status, 422)
        event = app.events[0]
        self.assertEqual(event["error_code"], "shell_tool_missing")
        self.assertEqual(event["error_stage"], "tool_selection")
        self.assertEqual(len(event["worker_digest"]), 64)

    def test_tool_error_result_is_never_turned_into_worker_success(self):
        app = FixtureApplication(self.root / "requests.ndjson", {"codex": self.root})
        first = {"model": "fixture-worker", "messages": [{"role": "user", "content": self.marker}],
                 "tools": [{"name": "bash", "input_schema": {"type": "object", "properties": {"command": {}}}}]}
        app.dispatch("POST", "/v1/messages", first)
        first["messages"].append({"role": "user", "content": [{"type": "tool_result",
            "tool_use_id": app.events[0]["tool_call_id"], "is_error": True, "content": "Permission denied " + SECRET}]})
        self.assertEqual(app.dispatch("POST", "/v1/messages", first).status, 422)
        self.assertEqual(app.events[1]["error_code"], "tool_result_error")
        self.assertIn("permission_denied", app.events[1]["diagnostic"]["categories"])
        self.assertNotIn(SECRET, app.request_log.read_text())

    def test_worker_stdout_categories_keep_event_types_not_raw_errors_or_command_paths(self):
        output = "\n".join(map(json.dumps, [
            {"type": "item.completed", "item": {"type": "command_execution", "output":
                "exec_command failed: CreateProcess failed " + SECRET + " exit code 127"}},
            {"type": SECRET, "message": "Authorization: Bearer " + SECRET},
            {"type": "turn.completed"}])).encode()
        diagnostic = worker_output_diagnostic(output, ("bwrap: Operation not permitted https://" + SECRET).encode())
        self.assertEqual(diagnostic["event_types"], ["item.completed", "turn.completed"])
        self.assertEqual(diagnostic["other_event_type_count"], 1)
        self.assertIn("sandbox_denied", diagnostic["categories"])
        self.assertIn("tool_process_start_failed", diagnostic["categories"])
        self.assertIn("tool_exit_nonzero", diagnostic["categories"])
        self.assertNotIn(SECRET, json.dumps(diagnostic))
        self.assertNotIn("https://", json.dumps(diagnostic))

    def test_codex_text_error_tool_result_is_rejected_instead_of_hallucinated_final(self):
        app = FixtureApplication(self.root / "requests.ndjson", {"codex": self.root})
        body = {"model": "fixture-worker", "input": [{"role": "user", "content": self.marker}],
                "tools": [{"type": "function", "name": "exec_command", "parameters": {"type": "object"}}]}
        app.dispatch("POST", "/v1/responses", body)
        body["input"].append({"type": "function_call_output", "call_id": app.events[0]["tool_call_id"],
                              "output": "exec_command failed: CreateProcess Operation not permitted " + SECRET})
        self.assertEqual(app.dispatch("POST", "/v1/responses", body).status, 422)
        self.assertEqual(app.events[1]["error_code"], "tool_result_error")
        self.assertIn("tool_process_start_failed", app.events[1]["diagnostic"]["categories"])
        self.assertNotIn(SECRET, app.request_log.read_text())

    def test_unknown_fixture_error_string_does_not_become_public_diagnostic(self):
        diagnostic = FixtureError("Authorization Bearer " + SECRET).diagnostic
        self.assertEqual(diagnostic, {"error_code": "fixture_request_invalid", "error_stage": "validation"})
        self.assertNotIn(SECRET, json.dumps(diagnostic))

    def test_tampered_worker_failure_json_cannot_inject_raw_output_or_harness_names(self):
        (self.root / "worker-failure.json").write_text(json.dumps({"status": SECRET, "harness": SECRET,
            "stage": SECRET, "protocol": SECRET, "exit_code": SECRET, "output": {"categories": [SECRET]}}))
        diagnostic = failure_context(self.root, [])
        self.assertNotIn(SECRET, json.dumps(diagnostic))
        self.assertEqual(diagnostic["worker"]["status"], "failed")

    def test_failure_context_retains_safe_worker_and_requests_without_private_file_names(self):
        (self.root / "harness.stdout.ndjson").write_bytes(b'{"type":"turn.completed"}')
        (self.root / "harness.stderr.log").write_bytes(b"Permission denied " + SECRET.encode())
        (self.root / "worker-failure.json").write_text(json.dumps({"schema_version": 1, "status": "failed",
            "harness": "codex", "stage": "artifact_ownership", "exit_code": 0, "protocol": "openai_responses",
            "output": worker_output_diagnostic(b'{"type":"turn.completed"}', b"Permission denied " + SECRET.encode())}))
        event = {"sequence": 1, "route": "openai_responses", "status": 422,
                 "error_code": "shell_tool_missing", "error_stage": "tool_selection",
                 "diagnostic": request_diagnostic({"messages": [{"role": "user", "content": SECRET}]})}
        context = failure_context(self.root, [event])
        self.assertEqual(context["worker"]["stage"], "artifact_ownership")
        self.assertEqual(context["requests"][0]["error_code"], "shell_tool_missing")
        self.assertNotIn(SECRET, json.dumps(context))
        self.assertNotIn(str(self.root), json.dumps(context))


if __name__ == "__main__":
    unittest.main()
