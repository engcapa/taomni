"""Offline validation tests; never launches workers, Git, or an HTTP server."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from receipts import (MARKER_NAME, assert_isolated_network, clean_environment, validate_artifact,
                      validate_stdout, validate_worker_events)


class IsolationTests(unittest.TestCase):
    def test_namespace_must_have_no_external_interface(self):
        assert_isolated_network({"lo"})
        for interfaces in ({"lo", "eth0"}, set(), {"eth0"}):
            with self.assertRaises(RuntimeError):
                assert_isolated_network(interfaces)

    def test_no_inherited_credentials_proxy_or_injection_environment(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret", "HTTP_PROXY": "bad",
                                     "ANTHROPIC_AUTH_TOKEN": "secret", "NODE_OPTIONS": "bad",
                                     "PYTHONPATH": "bad", "SSH_AUTH_SOCK": "secret"}):
            env = clean_environment(Path("/owned/home"), "/trusted/bin:/usr/bin:/bin")
        for key in ("OPENAI_API_KEY", "HTTP_PROXY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS",
                    "PYTHONPATH", "SSH_AUTH_SOCK"):
            self.assertNotIn(key, env)
        self.assertEqual(env["HOME"], "/owned/home")
        self.assertEqual(env["NO_PROXY"], "127.0.0.1,localhost")


class EvidenceTests(unittest.TestCase):
    def events(self):
        base = {"worker_digest": hashlib.sha256(b"worker-a").hexdigest(), "route": "openai_responses",
                "status": 200, "tool_call_id": "call-owned", "request_sha256": "hash"}
        return [{**base, "scenario": "worker-tool", "tool_name": "exec_command", "request_id": "first"},
                {**base, "scenario": "worker-final", "tool_result_seen": True, "request_id": "second"}]

    def test_two_real_generation_requests_with_matching_tool_result_required(self):
        events = self.events()
        receipt = validate_worker_events(events, "worker-a", "openai_responses")
        self.assertEqual(receipt["generation_requests"], 2)
        self.assertEqual(receipt["tool_name"], "exec_command")
        bad_sequences = [[], events[:1], events + events[:1],
                         [events[0], {**events[1], "tool_call_id": "wrong"}],
                         [events[0], {**events[1], "tool_result_seen": False}],
                         events + [{"route": "unknown", "status": 404}]]
        for rows in bad_sequences:
            with self.subTest(rows=rows), self.assertRaises(AssertionError):
                validate_worker_events(rows, "worker-a", "openai_responses")
        with self.assertRaises(AssertionError):
            validate_worker_events(events, "worker-a", "anthropic_messages")

    def test_marker_ownership_requires_exact_content_real_file_and_unique_worktree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            worker, other, repo = [root / name for name in ("worker", "other", "repo")]
            for directory in (worker, other, repo):
                directory.mkdir()
            marker = worker / MARKER_NAME
            expected = "taomni:run:worker-a\n"
            with self.assertRaises(AssertionError):
                validate_artifact(worker, expected, [other], repo)
            marker.write_text(expected)
            receipt = validate_artifact(worker, expected, [other], repo)
            self.assertEqual(receipt["size"], len(expected))
            (other / MARKER_NAME).write_text(expected)
            with self.assertRaises(AssertionError):
                validate_artifact(worker, expected, [other], repo)
            (other / MARKER_NAME).unlink()
            marker.unlink()
            (other / MARKER_NAME).write_text(expected)
            marker.symlink_to(other / MARKER_NAME)
            with self.assertRaises(AssertionError):
                validate_artifact(worker, expected, [other], repo)

    def final(self):
        return {"type": "worker_result", "status": "completed", "run_id": "run",
                "worker_id": "worker-a", "artifact": MARKER_NAME}

    def test_stdout_final_and_native_terminal_both_required(self):
        cases = {
            "claude-code": [{"type": "result", "subtype": "success", "is_error": False,
                             "result": json.dumps(self.final())}],
            "codex": [{"type": "item.completed", "item": {"text": json.dumps(self.final())}},
                      {"type": "turn.completed"}],
            "pi": [{"type": "message_end", "message": {"content": [{"type": "text", "text": json.dumps(self.final())}]}},
                   {"type": "agent_end"}],
            "opencode": [{"type": "text", "part": {"text": json.dumps(self.final())}}, {"type": "step_finish"}],
            "deepseek-harness": [{"type": "final", "reason": {"kind": "completed"}, "text": json.dumps(self.final())}],
            "zcode": [{"type": "result", "response": json.dumps(self.final())}],
        }
        for harness, rows in cases.items():
            with self.subTest(harness=harness):
                output = "\n".join(map(json.dumps, rows)).encode()
                self.assertTrue(validate_stdout(harness, output, "run", "worker-a")["matching_final_result"])
                with self.assertRaises(AssertionError):
                    validate_stdout(harness, output, "run", "wrong-worker")
        for output in (b"", b"fake successful message", b'{"type":"turn.completed"}',
                       json.dumps({"type": "result", "is_error": True, "result": json.dumps(self.final())}).encode()):
            with self.assertRaises(AssertionError):
                validate_stdout("claude-code", output, "run", "worker-a")


if __name__ == "__main__":
    unittest.main()
