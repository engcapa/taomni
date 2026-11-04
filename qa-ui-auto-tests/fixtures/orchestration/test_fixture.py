"""Stdlib-only offline contract tests. No HTTP listeners or real workers run here."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import FixtureError, PACK_MARKER, WORKER_MARKER, decide, pack_text
from protocols import stream_response
from server import FixtureApplication

PROTOCOLS = {"openai_chat": "/v1/chat/completions", "openai_responses": "/v1/responses",
             "anthropic_messages": "/v1/messages"}
MANIFEST = {"pack_id": "run-unit-42", "input_digest": "digest-42",
            "expected_ids": ["design", "contract", "tests"], "group_id": "g1"}


def request(protocol, text, **extra):
    body = {"model": "fixture-complete", **extra}
    if protocol == "openai_responses":
        body["input"] = [{"role": "user", "content": [{"type": "input_text", "text": text}]}]
    else:
        body["messages"] = [{"role": "user", "content": text}]
    return body


def events(reply):
    frames = []
    for frame in reply.body:
        text = frame.decode()
        payload = next(line[6:] for line in text.splitlines() if line.startswith("data: "))
        if payload != "[DONE]":
            frames.append(json.loads(payload))
    return frames


class PackTests(unittest.TestCase):
    def test_ids_and_digest_come_from_prompt_not_fixture_constants(self):
        manifest = {**MANIFEST, "pack_id": "new-run", "expected_ids": ["review"]}
        rows = [json.loads(line) for line in pack_text(manifest).splitlines()]
        self.assertEqual(rows[0]["pack_id"], "new-run")
        self.assertEqual(rows[0]["input_digest"], MANIFEST["input_digest"])
        self.assertEqual(rows[-1]["item_ids"], ["review"])
        self.assertEqual([row["item_id"] for row in rows if row["type"] == "item_end"], ["review"])

    def test_partial_keeps_two_complete_candidates_then_recovery_completes_missing_only(self):
        body = request("openai_chat", PACK_MARKER + json.dumps(MANIFEST), model="fixture-partial")
        result = decide(body, "openai_chat")
        rows = [json.loads(line) for line in result.text.splitlines()]
        self.assertEqual([row["item_id"] for row in rows if row["type"] == "item_end"], ["design", "contract"])
        self.assertEqual(rows[-1]["type"], "item_chunk")
        recovery = {**MANIFEST, "expected_ids": ["tests"]}
        result = decide(request("openai_chat", PACK_MARKER + json.dumps(recovery) + "\nTAOMNI_RECOVERY=true",
                                model="fixture-partial"), "openai_chat")
        rows = [json.loads(line) for line in result.text.splitlines()]
        self.assertEqual(rows[-1]["type"], "pack_end")
        self.assertEqual(rows[-1]["item_ids"], ["tests"])
        self.assertEqual(result.scenario, "complete")

    def test_tail_partial_ends_with_complete_second_item_without_lf(self):
        result = decide(request("anthropic_messages", PACK_MARKER + json.dumps(MANIFEST),
                                model="fixture-tail-partial"), "anthropic_messages")
        self.assertEqual(result.scenario, "partial")
        self.assertFalse(result.text.endswith("\n"))
        rows = [json.loads(line) for line in result.text.splitlines()]
        self.assertEqual([row["item_id"] for row in rows if row["type"] == "item_end"], ["design", "contract"])
        self.assertEqual(rows[-1], {"type": "item_end", "item_id": "contract", "chunk_count": 1, "status": "candidate"})
        self.assertNotIn("group_end", [row["type"] for row in rows])
        self.assertNotIn("pack_end", [row["type"] for row in rows])
        legacy = decide(request("anthropic_messages", PACK_MARKER + json.dumps(MANIFEST),
                                model="fixture-partial"), "anthropic_messages")
        self.assertTrue(legacy.text.endswith("\n"))
        self.assertEqual(json.loads(legacy.text.splitlines()[-1])["type"], "item_chunk")

    def test_tail_recovery_accepts_only_missing_tests_not_replaying_saved_items(self):
        text = PACK_MARKER + json.dumps({**MANIFEST, "expected_ids": ["tests"]}) + "\nTAOMNI_RECOVERY=true"
        result = decide(request("anthropic_messages", text, model="fixture-tail-partial"), "anthropic_messages")
        self.assertEqual(result.scenario, "complete")
        self.assertEqual(json.loads(result.text.splitlines()[-1])["item_ids"], ["tests"])
        for ids in (["design", "contract", "tests"], ["contract", "tests"]):
            with self.subTest(ids=ids), self.assertRaises(FixtureError):
                decide(request("anthropic_messages", PACK_MARKER + json.dumps({**MANIFEST, "expected_ids": ids})
                               + "\nTAOMNI_RECOVERY=true", model="fixture-tail-partial"), "anthropic_messages")

    def test_escaped_source_markers_and_embedded_substrings_are_not_host_metadata(self):
        hostile = 'TAOMNI_SOURCE=' + json.dumps({"content": PACK_MARKER + json.dumps(MANIFEST)})
        body = request("openai_chat", hostile)
        with self.assertRaises(FixtureError):
            decide(body, "openai_chat")
        with self.assertRaises(FixtureError):
            decide(request("openai_chat", "quoted: " + PACK_MARKER + json.dumps(MANIFEST)), "openai_chat")
        text = PACK_MARKER + json.dumps(MANIFEST) + "\nTAOMNI_SOURCE=" + json.dumps({"content": "TAOMNI_RECOVERY=true"})
        decision = decide(request("openai_chat", text, model="fixture-partial"), "openai_chat")
        self.assertEqual(decision.scenario, "partial")

    def test_bad_manifests_fail_explicitly(self):
        for manifest in ({}, {**MANIFEST, "expected_ids": ["a", "a"]},
                         {**MANIFEST, "pack_id": "../escape"}, {**MANIFEST, "expected_ids": []}):
            with self.subTest(manifest=manifest), self.assertRaises(FixtureError):
                pack_text(manifest)
        with self.assertRaises(FixtureError):
            decide({"messages": [{"content": PACK_MARKER + "not-json"}]}, "openai_chat")


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.log = Path(self.temp.name) / "requests.ndjson"
        self.app = FixtureApplication(self.log)
        self.addCleanup(self.temp.cleanup)

    def test_generation_all_protocols_json_and_sse(self):
        for protocol, path in PROTOCOLS.items():
            for streaming in (False, True):
                with self.subTest(protocol=protocol, streaming=streaming):
                    body = request(protocol, PACK_MARKER + json.dumps(MANIFEST), stream=streaming)
                    reply = self.app.dispatch("POST", path, body)
                    self.assertEqual(reply.status, 200)
                    self.assertEqual(reply.streaming, streaming)
                    if streaming:
                        rows = events(reply)
                        self.assertTrue(any("pack_start" in json.dumps(row) for row in rows))
                        terminal = {"openai_chat": lambda: rows[-2]["choices"][0]["finish_reason"] == "stop",
                                    "openai_responses": lambda: rows[-1]["type"] == "response.completed",
                                    "anthropic_messages": lambda: rows[-1]["type"] == "message_stop"}
                        self.assertTrue(terminal[protocol]())
                    else:
                        self.assertIn("pack_end", json.dumps(reply.body))
        self.assertEqual(len(self.app.events), 6)

    def test_stream_errors_and_missing_terminal_are_not_success(self):
        terminal = {"openai_chat": "stop", "openai_responses": "response.completed",
                    "anthropic_messages": "message_stop"}
        for protocol, path in PROTOCOLS.items():
            for scenario in ("error", "truncated", "partial"):
                with self.subTest(protocol=protocol, scenario=scenario):
                    reply = self.app.dispatch("POST", path, request(
                        protocol, PACK_MARKER + json.dumps(MANIFEST), model="fixture-" + scenario, stream=True))
                    rows = events(reply)
                    text = json.dumps(rows)
                    if scenario != "partial" or protocol != "anthropic_messages":
                        self.assertNotIn('"' + terminal[protocol] + '"', text)
                    else:
                        self.assertNotIn('"end_turn"', text)
                    if scenario == "error":
                        self.assertIn("intentional fixture failure", text)
                    elif scenario == "partial":
                        self.assertIn({"openai_chat": "length", "openai_responses": "response.incomplete",
                                       "anthropic_messages": "max_tokens"}[protocol], text)

    def test_tail_partial_sse_has_max_tokens_and_message_stop_but_no_pack_end(self):
        reply = self.app.dispatch("POST", "/v1/messages", request(
            "anthropic_messages", PACK_MARKER + json.dumps(MANIFEST), model="fixture-tail-partial", stream=True))
        rows = events(reply)
        text = "".join(row["delta"]["text"] for row in rows if row["type"] == "content_block_delta")
        self.assertFalse(text.endswith("\n"))
        self.assertEqual(json.loads(text.splitlines()[-1])["item_id"], "contract")
        self.assertEqual(rows[-2]["delta"]["stop_reason"], "max_tokens")
        self.assertEqual(rows[-1]["type"], "message_stop")
        self.assertEqual(self.app.events[0]["scenario"], "partial")
        self.assertEqual(self.app.events[0]["route"], "anthropic_messages")
        self.assertNotIn("pack_end", text)

    def test_models_counting_http_error_and_bad_routes(self):
        reply = self.app.dispatch("GET", "/v1/models")
        self.assertIn("fixture-worker", [item["id"] for item in reply.body["data"]])
        self.assertEqual(self.app.dispatch("POST", "/v1/messages/count_tokens", {}).body, {"input_tokens": 128})
        self.assertEqual(self.app.dispatch("POST", "/v1/messages/count_tokens?beta=true", {}).body, {"input_tokens": 128})
        self.assertEqual(self.app.dispatch("POST", "/v1/messages?beta=true", request(
            "anthropic_messages", PACK_MARKER + json.dumps(MANIFEST))).status, 200)
        self.assertEqual(self.app.dispatch("POST", "/v1/models", {}).status, 405)
        for path in ("/v1/v1/responses", "/v1/responses?secret=hidden", "https://example.test/v1/responses"):
            self.assertEqual(self.app.dispatch("POST", path, {}).status, 404)
        reply = self.app.dispatch("POST", "/v1/responses", request(
            "openai_responses", PACK_MARKER + json.dumps(MANIFEST), model="fixture-http-error"))
        self.assertEqual(reply.status, 503)
        self.assertEqual(self.app.dispatch("POST", "/v1/responses", {}).status, 422)

    def test_no_prompt_headers_tool_results_model_or_unknown_path_in_request_log(self):
        secret = "do-not-log-supersecret-123"
        body = request("openai_chat", secret + "\n" + PACK_MARKER + json.dumps(MANIFEST), model=secret)
        body["api_key"] = secret
        body["authorization"] = "Bearer " + secret
        self.app.dispatch("POST", "/v1/chat/completions", body)
        self.app.dispatch("GET", "/" + secret)
        logged = self.log.read_text()
        self.assertNotIn(secret, logged)
        self.assertIn("request_sha256", logged)
        self.assertEqual([row["sequence"] for row in map(json.loads, logged.splitlines())], [1, 2])


class WorkerDecisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = {"mode": "worker", "run_id": "ci-run", "worker_id": "worker-a",
                       "marker_path": "taomni-worker-marker.txt", "marker_text": "taomni:ci-run:worker-a\n"}

    def body(self, protocol, name="bash", schema=None):
        body = request(protocol, WORKER_MARKER + json.dumps(self.worker))
        tool = {"name": name, "description": "real shell", "parameters": schema or {"type": "object"}}
        if protocol == "openai_chat":
            body["tools"] = [{"type": "function", "function": tool}]
        elif protocol == "anthropic_messages":
            body["tools"] = [{"name": name, "input_schema": tool["parameters"]}]
        else:
            body["tools"] = [{"type": "function", **tool}]
        return body

    def test_tool_call_then_matching_tool_result_then_final_on_every_protocol(self):
        for protocol in PROTOCOLS:
            with self.subTest(protocol=protocol):
                body = self.body(protocol)
                first = decide(body, protocol, {"worker-a": self.root})
                self.assertEqual(first.tool_name, "bash")
                self.assertIn("printf", first.tool_args["command"])
                self.assertFalse((self.root / self.worker["marker_path"]).exists())
                if protocol == "openai_chat":
                    body["messages"].append({"role": "tool", "tool_call_id": first.call_id, "content": ""})
                elif protocol == "openai_responses":
                    body["input"].append({"type": "function_call_output", "call_id": first.call_id, "output": ""})
                else:
                    body["messages"].append({"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": first.call_id, "content": ""}]})
                final = decide(body, protocol, {"worker-a": self.root})
                self.assertTrue(final.tool_result_seen)
                self.assertEqual(json.loads(final.text)["worker_id"], "worker-a")
                self.assertEqual(json.loads(final.text)["status"], "completed")
                # Pure fixture decisions cannot fabricate filesystem evidence.
                self.assertFalse((self.root / self.worker["marker_path"]).exists())

    def test_registered_worker_no_tool_wrong_id_and_path_escape_cannot_pass(self):
        body = self.body("openai_chat")
        with self.assertRaises(FixtureError):
            decide(body, "openai_chat")
        body["tools"] = []
        with self.assertRaises(FixtureError):
            decide(body, "openai_chat", {"worker-a": self.root})
        self.worker["marker_path"] = "../escape"
        with self.assertRaises(FixtureError):
            decide(self.body("openai_chat"), "openai_chat", {"worker-a": self.root})

    def test_known_shell_tool_shapes(self):
        for name, key in (("Bash", "command"), ("shell_command", "command"), ("exec_command", "cmd"),
                          ("shell", "command"), ("bash", "command")):
            with self.subTest(name=name):
                result = decide(self.body("openai_responses", name), "openai_responses", {"worker-a": self.root})
                self.assertIn(key, result.tool_args)
                self.assertEqual(result.tool_name, name)
                if name == "shell":
                    self.assertEqual(result.tool_args["workdir"], str(self.root))
                    self.assertIsInstance(result.tool_args["command"], list)
                for protocol in PROTOCOLS:
                    frames = list(stream_response(protocol, "fixture-worker", result, "unit-request"))
                    self.assertIn(name, b"".join(frames).decode())


if __name__ == "__main__":
    unittest.main()
