"""Unit tests for protocol evidence and run-owned AI fixture input/cleanup."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
import urllib.request
from unittest.mock import patch

from qa_ui_auto.fixtures import ai_chat_provider as fixture
from native_build import QA_APP_ID


class AiChatProviderTest(unittest.TestCase):
    def test_real_sse_body_and_independent_request_receipt(self):
        with TemporaryDirectory() as directory:
            server = fixture.ProviderServer(Path(directory) / "requests.json")
            try:
                body = {"stream": True, "model": "qa-model", "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "SHELL AI 第一条"}]}
                request = urllib.request.Request(server.base_url + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": "Bearer never-record-this"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                    raw = response.read().decode("utf-8")
                payloads = [json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:") and line != "data: [DONE]"]
                tokens = "".join(p["choices"][0]["delta"].get("content", "") for p in payloads)
                self.assertEqual(tokens, fixture.REPLY)
                self.assertIn("data: [DONE]", raw)
                receipt = server.receipt.read_text(encoding="utf-8")
                self.assertNotIn("never-record-this", receipt)
                self.assertEqual(json.loads(receipt), {"requests": 1, "streamRequests": 1, "toolRequests": 0, "lastUserMessage": "SHELL AI 第一条", "model": "qa-model"})
            finally:
                server.stop()

    def test_native_fixture_refuses_nonisolated_environment(self):
        with TemporaryDirectory() as directory:
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=Path(directory), case_dir=Path(directory) / "case", values={})
            with patch.object(fixture, "native_isolation_env", return_value={"QA_FIXTURE_ROOT": directory}), patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "isolation"):
                    fixture.setup(ctx)
            self.assertFalse(hasattr(ctx, "_ai_chat_provider"))

    def test_sse_with_production_tool_catalog_records_tools_without_secret_payload(self):
        with TemporaryDirectory() as directory:
            server = fixture.ProviderServer(Path(directory) / "requests.json")
            try:
                body = {"stream": True, "model": "qa-model", "messages": [{"role": "user", "content": "test"}],
                        "tools": [{"type": "function", "function": {"name": "list", "parameters": {"type": "object"}}}]}
                request = urllib.request.Request(server.base_url + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertIn(b"data: [DONE]", response.read())
                receipt = json.loads(server.receipt.read_text(encoding="utf-8"))
                self.assertEqual((receipt["requests"], receipt["streamRequests"], receipt["toolRequests"]), (1, 1, 1))
                self.assertNotIn("tools", receipt)
            finally:
                server.stop()

    def test_linux_fixture_uses_xdg_config_without_the_qa_app_id_layer(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config_root = root / "native-config"
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root, case_dir=root / "case", values={})
            expected = {"XDG_CONFIG_HOME": str(config_root)}
            with patch.object(fixture, "native_isolation_env", return_value=expected), patch.dict(os.environ, expected):
                fixture.setup(ctx)
                try:
                    self.assertEqual(ctx._ai_config_target, config_root / "taomni" / "ai.json")
                    self.assertTrue(ctx._ai_config_target.is_file())
                finally:
                    fixture.teardown(ctx)
                self.assertFalse(ctx._ai_config_target.exists())

    def test_native_fixture_restores_previous_config_and_only_uses_owned_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config_root = root / "native-config"
            target = config_root / QA_APP_ID / "taomni" / "ai.json"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"previous configuration")
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root, case_dir=root / "case", values={})
            expected = {"NEWMOB_CONFIG_DIR": str(config_root)}
            with patch.object(fixture, "native_isolation_env", return_value=expected), patch.dict(os.environ, expected):
                fixture.setup(ctx)
                try:
                    config = json.loads(target.read_text())
                    self.assertTrue(config["llm"]["providers"]["qa-loopback"]["base_url"].startswith("http://127.0.0.1:"))
                    self.assertEqual(config["llm"]["providers"]["qa-loopback"]["runtime"], "openai-compat")
                finally:
                    fixture.teardown(ctx)
            self.assertEqual(target.read_bytes(), b"previous configuration")


if __name__ == "__main__":
    unittest.main()
