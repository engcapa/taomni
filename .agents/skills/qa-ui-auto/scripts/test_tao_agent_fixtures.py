"""Provider isolation, live key-file cleanup and the actual ACP peer protocol."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import Request, ProxyHandler, build_opener

from tauri_webdriver import native_isolation_env
from qa_ui_auto.fixtures import tao_agent, tao_real_provider


class AgentFixtureTests(unittest.TestCase):
    def context(self, root):
        case = root / "case"
        case.mkdir()
        return SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root,
                               case_dir=case, values={}, session=None)

    def test_live_go_key_file_defaults_and_cleanup_on_failed_case(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            key = root / "temporary.key"
            key.write_text("\ufefftemporary-qa-secret\n", encoding="utf-8")
            ctx = self.context(root)
            with patch.dict(os.environ, {"TAOMNI_QA_OPENCODE_KEY_FILE": str(key)}, clear=True):
                tao_real_provider.setup(ctx)
            config_path = Path(ctx.values["tao_real_provider_config"])
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(config["deepseek_app"]["provider"], "opencode-go")
            self.assertEqual(config["deepseek_app"]["model"], "deepseek-v4.1-flash")
            self.assertEqual(config["deepseek_app"]["reasoning_effort"], "max")
            self.assertTrue(config["deepseek_app"]["thinking_default"])
            self.assertEqual(config["llm"]["providers"]["opencode-go"]["api_key"], "temporary-qa-secret")
            self.assertFalse(config["llm"]["fallback"]["enabled"])
            tao_real_provider.teardown(ctx)
            self.assertFalse(config_path.exists())
            self.assertTrue(key.exists(), "The caller owns the temporary credential file")
            for artifact in ctx.case_dir.iterdir():
                self.assertNotIn("temporary-qa-secret", artifact.read_text(encoding="utf-8"))

    def test_cleanup_refuses_files_outside_the_isolated_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "report").mkdir()
            ctx = self.context(root / "report")
            external = root / "ai.json"
            external.write_text("private", encoding="utf-8")
            ctx.values["tao_real_provider_config"] = str(external)
            with self.assertRaises(RuntimeError):
                tao_real_provider.teardown(ctx)
            self.assertEqual(external.read_text(encoding="utf-8"), "private")

    def test_loopback_uses_real_http_and_records_only_request_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            ctx = self.context(root)
            with patch.dict(os.environ, native_isolation_env(root), clear=True):
                tao_agent.setup(ctx)
            try:
                config = json.loads(Path(ctx.values["tao_real_provider_config"]).read_text(encoding="utf-8"))
                # Missing these fields makes native AiConfig.load silently use defaults.
                self.assertTrue({"asr", "llm"} <= config.keys())
                self.assertTrue({"active", "providers", "fallback", "task_routing"} <= config["llm"].keys())
                url = config["llm"]["providers"]["opencode-go"]["base_url"] + "/chat/completions"
                body = dict(model="deepseek-v4.1-flash", reasoning_effort="max", thinking={"type": "enabled"},
                            messages=[dict(role="user", content="Private prompt: minimal Python calculator")])
                req = Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
                    stream = response.read().decode()
                self.assertIn("tao-action", stream)
                self.assertIn("[DONE]", stream)
                metadata = Path(ctx.values["tao_agent_log"]).read_text(encoding="utf-8")
                self.assertNotIn("Private prompt", metadata)
                self.assertEqual(json.loads(metadata)["effort"], "max")
                body["messages"] = [dict(role="user", content="QA_CONTEXT_TOOL_ROUND: inspect the context")]
                req = Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
                    frames = [json.loads(line[6:]) for line in response.read().decode().splitlines()
                              if line.startswith("data: ") and line != "data: [DONE]"]
                calls = frames[1]["choices"][0]["delta"]["tool_calls"]
                self.assertEqual([call["function"]["name"] for call in calls],
                                 ["list_workspace_files", "read_workspace_file", "search_local_records"])
                body["messages"].append(dict(role="tool", content="actual native tool result"))
                req = Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
                    self.assertIn("actual workspace guide", response.read().decode())
                action = dict(id="same-proposal", kind="run_command", title="Review", payload=dict(command="echo exact reviewed bytes"))
                body["messages"] = [dict(role="user", content="QA_ACTION_CONTROLS\n" + json.dumps(action) + "\nQA_END_ACTION")]
                req = Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
                    frames = [json.loads(line[6:]) for line in response.read().decode().splitlines()
                              if line.startswith("data: ") and line != "data: [DONE]"]
                proposal = frames[1]["choices"][0]["delta"]["content"]
                self.assertIn("tao-action", proposal)
                self.assertEqual(json.loads(proposal.split("```tao-action\n", 1)[1].split("\n```", 1)[0]), action)
            finally:
                tao_agent.teardown(ctx)

    def test_acp_peer_is_a_real_ndjson_subprocess_with_context_and_no_draft(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / "handoff.json"
            requests = [dict(id=1, method="initialize"), dict(id=2, method="session/new"),
                        dict(id=3, method="session/prompt", params=dict(prompt=[dict(type="text", text="Build a Python project <untrusted_tao_history>reviewed turns</untrusted_tao_history>")]))]
            result = subprocess.run([sys.executable, str(Path(tao_agent.__file__).with_name("tao_agent_acp.py")), str(log)],
                                    input="".join(json.dumps(req) + "\n" for req in requests),
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            frames = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual([frame["id"] for frame in frames if "id" in frame], [1, 2, 3])
            self.assertTrue(any(frame.get("method") == "session/update" for frame in frames))
            self.assertEqual(frames[-1]["result"]["stopReason"], "end_turn")
            self.assertEqual(json.loads(log.read_text()), dict(received=True, hasGoal=True, hasHistory=True, hasUnsavedDraft=False))


if __name__ == "__main__":
    unittest.main()
