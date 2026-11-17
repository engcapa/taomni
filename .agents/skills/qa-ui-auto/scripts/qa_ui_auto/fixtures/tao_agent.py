"""Loopback Go protocol fixture; real native actions/processes, no commercial AI.

Complements TC-TAO-HOME-024's actual inference. It makes the executor lifecycle
deterministic and available on hosted Linux/macOS without uploading a key.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from . import tao_real_provider

GOOD = "def add(a, b):\n    return a + b\n\ndef multiply(a, b):\n    return a * b\n"
BAD = GOOD.replace("return a + b", "return a - b")
NESTED_README = '# Nested fences\n\n```sh\npython -m unittest\n```\n\nQuotes "value"; path C:\\work\\tasks.\n\n```tao-action\n{"id":"example-only","kind":"run_command","title":"Example","payload":{"command":"echo example"}}\n```\n'
DIVIDE = "\ndef divide(a, b):\n    if b == 0:\n        raise ValueError('zero divisor')\n    return a / b\n"
TESTS = """import unittest
from calculator import add, multiply

class CalculatorTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(3, 5), 8)
        self.assertEqual(add(-3, 5), 2)
        self.assertEqual(add(0, 0), 0)
    def test_multiply(self):
        self.assertEqual(multiply(3, 5), 15)
        self.assertEqual(multiply(-3, 5), -15)
        self.assertEqual(multiply(0, 5), 0)
"""
DIVIDE_TEST = """
    def test_divide(self):
        from calculator import divide
        self.assertEqual(divide(3, 2), 1.5)
        with self.assertRaises(ValueError):
            divide(1, 0)
"""


def scripted_reply(prompt):
    def file(name, content):
        # Deliberately reuse model proposal IDs across repair rounds. The app
        # must distinguish proposal instances and never return an old write.
        return dict(id=name, kind="write_file", title="Write " + name, payload=dict(path=name, content=content))
    if "QA_FEED_FOLLOWING" in prompt:
        return "## Streamed document\n\n" + "\n\n".join(
            f"Paragraph {index}: Read the complete streamed document, including its delayed layout and final result."
            for index in range(1, 15)
        ) + "\n\n| Expression | Result |\n| --- | --- |\n| 2 + 3 | 5 |\n\n```python\nprint(5)\n```\n\nQA_FEED_COMPLETE"
    if "QA_ACTION_NESTED_FENCES" in prompt:
        actions = [file("README.md", NESTED_README), file("status.txt", "Ready\n")]
    elif "QA_ACTION_CONTROLS\n" in prompt:
        encoded = prompt.split("QA_ACTION_CONTROLS\n", 1)[1].split("\nQA_END_ACTION", 1)[0]
        actions = [json.loads(encoded)]
    elif "test command in the bound workspace" in prompt:
        actions = [dict(id="tests", kind="run_command", title="Run tests", payload=dict(command=prompt.rsplit("Command: ", 1)[1]))]
    elif "intentionally wrong" in prompt:
        actions = [file("calculator.py", BAD)]
    elif "diagnose and repair" in prompt:
        actions = [file("calculator.py", GOOD)]
    elif "Extend the existing project" in prompt:
        actions = [file("calculator.py", GOOD + DIVIDE), file("test_calculator.py", TESTS + DIVIDE_TEST)]
    elif "minimal Python calculator" in prompt:
        actions = [file("calculator.py", GOOD), file("test_calculator.py", TESTS)]
    else:
        return "Reviewed the observed test results. Development, failure feedback, repair and feature extension are complete."
    return "Plan: review and execute each proposal.\n" + "\n".join("```tao-action\n" + json.dumps(action) + "\n```" for action in actions)


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        raise RuntimeError("tao_agent requires actual native IPC and filesystem")
    isolated = native_isolation_env(Path(ctx.report_root).resolve())
    if any(os.environ.get(key) != value for key, value in isolated.items()):
        raise RuntimeError("tao_agent requires the current isolated QA profile")
    log = ctx.case_dir / "agent-gateway.jsonl"
    limit_attempts = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            user = next(message for message in reversed(body["messages"]) if message["role"] == "user")
            blocks = user["content"]
            prompt = "\n".join(part.get("text", "") for part in blocks) if isinstance(blocks, list) else blocks
            with log.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(dict(model=body["model"], effort=body.get("reasoning_effort"), thinking=body.get("thinking"), max_tokens=body.get("max_tokens"), messages=len(body["messages"]), feedback="untrusted_action_results" in prompt, failure="test failed" in prompt or "FAILED" in prompt, boundary="loopback scripted response; real native executor")) + "\n")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            text = scripted_reply(prompt)
            calls = None
            if "QA_CONTEXT_TOOL_ROUND:" in prompt:
                if body["messages"][-1]["role"] == "tool":
                    text = "Reviewed the selected note, actual workspace guide and Taomni capability sources. Complete testing before deployment; further environment verification is needed."
                else:
                    calls = [dict(index=index, id="context-" + str(index), type="function", function=dict(name=name, arguments=json.dumps(args)))
                             for index, (name, args) in enumerate((("list_workspace_files", {"path": "."}), ("read_workspace_file", {"path": "guide.md"}), ("search_local_records", {"query": "SSH source:capabilities"})))]
            frames = [dict(choices=[dict(index=0, delta=dict(role="assistant", reasoning_content="Review actual results and propose the next step."), finish_reason=None)]),
                      dict(choices=[dict(index=0, delta=dict(tool_calls=calls) if calls else dict(content=text), finish_reason=None)]),
                      dict(choices=[dict(index=0, delta={}, finish_reason="tool_calls" if calls else "stop")], usage=dict(prompt_tokens=100, completion_tokens=50))]
            streaming_document = "QA_FEED_FOLLOWING" in prompt
            if streaming_document:
                frames[1:2] = [dict(choices=[dict(index=0, delta=dict(content=text[start:start + 48]), finish_reason=None)])
                               for start in range(0, len(text), 48)]
            for marker in ("QA_OUTPUT_LIMIT_THINKING", "QA_OUTPUT_LIMIT_ACTION"):
                if marker not in prompt:
                    continue
                limit_attempts[marker] = limit_attempts.get(marker, 0) + 1
                if limit_attempts[marker] == 1:
                    partial = "" if marker.endswith("THINKING") else scripted_reply("minimal Python calculator") + "\nIncomplete next file:"
                    frames[1]["choices"][0]["delta"] = dict(content=partial)
                    frames[2]["choices"][0]["finish_reason"] = "length"
                else:
                    frames[1]["choices"][0]["delta"] = dict(content="Explicit regeneration completed with a usable response.")
                break
            try:
                for frame in frames:
                    self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
                    if streaming_document:
                        self.wfile.flush()
                        time.sleep(.035)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ctx.tao_agent_server = server
    root = Path(isolated.get("NEWMOB_CONFIG_DIR") or isolated["XDG_CONFIG_HOME"])
    if isolated.get("NEWMOB_CONFIG_DIR"):
        root /= QA_APP_ID
    root = root / "taomni"
    root.mkdir(parents=True, exist_ok=True)
    config = dict(
        asr=dict(active="sensevoice-small", providers={}, warm_on_startup=False, vad="silero", language="auto"),
        llm=dict(active="opencode-go", providers={"opencode-go":dict(base_url=f"http://127.0.0.1:{server.server_port}", api_key="qa-loopback-only", model="deepseek-v4.1-flash", runtime="opencode-go", proxy_mode="none")},
                 fallback=dict(enabled=False, primary="opencode-go", secondary="local", timeout_ms=30000), task_routing={}),
        deepseek_app=dict(enabled=True, provider="opencode-go", model="deepseek-v4.1-flash", reasoning_effort="max", thinking_default=True, search_default=False, title_enabled=False),
        full_local_mode=False, fully_disabled=False)
    acp_log = ctx.case_dir / "acp-handoff.json"
    config["acp_bridge"] = dict(enabled=True, active_profile_id="qa-tao", proxy_mode="direct", profiles=[dict(id="qa-tao", name="QA Tao peer", enabled=True, command=sys.executable, args=[str(Path(__file__).with_name("tao_agent_acp.py").resolve()), str(acp_log.resolve())], proxy_mode="direct")])
    config_path = root / "ai.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    ctx.values["tao_real_provider_config"] = str(config_path)
    ctx.values["tao_agent_log"] = str(log)
    (ctx.case_dir / "real-provider-config.json").write_text(json.dumps(dict(provider="opencode-go", model="deepseek-v4.1-flash", tokenBudget=0, transport="loopback", reasoningEffort="max")), encoding="utf-8")


def teardown(ctx):
    server = getattr(ctx, "tao_agent_server", None)
    if server:
        server.shutdown()
        server.server_close()
    tao_real_provider.teardown(ctx)
