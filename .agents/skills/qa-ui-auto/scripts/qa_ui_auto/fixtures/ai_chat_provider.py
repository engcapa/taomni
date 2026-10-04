"""Native OpenAI protocol fixture; browser uses the declared IPC preview stub."""
from __future__ import annotations

import http.server
import json
import os
import select
import socket
from pathlib import Path
import threading
import time
from typing import Any

from tauri_webdriver import native_isolation_env


REPLY = "SHELL AI response 中文\nSecond paragraph"


def config(base_url: str) -> dict:
    return {
        "asr": {"active": "", "providers": {}, "warm_on_startup": False, "vad": "silero"},
        "llm": {"active": "qa-loopback", "providers": {"qa-loopback": {
            "base_url": base_url, "api_key": "local", "model": "qa-model", "runtime": "openai-compat",
            "capabilities": {"chat": True}, "proxy_mode": "none"}},
            "provider_groups": {}, "task_routing": {}, "fallback": {"enabled": False, "primary": "qa-loopback", "secondary": "", "timeout_ms": 10000}},
        "web_search": {"client_provider": "searxng", "client_enabled": False, "confirm_mode": "disabled", "byok_key": "", "searxng_url": None},
        "cc_bridge": {"enabled": False, "binary": "claude", "min_version": "", "default_model": "", "permission_mode": "default", "max_turns": 1},
        "codex_bridge": {"enabled": False, "binary": "codex", "min_version": "", "default_model": "", "sandbox": "read-only", "approval_policy": "never"},
        "acp_bridge": {"enabled": False, "profiles": [], "proxy_mode": "direct", "request_timeout_seconds": 30},
        "full_local_mode": False, "fully_disabled": False, "chat_output_format": "plain", "chat_send_shortcut": "ctrl_enter",
    }


class ProviderServer:
    def __init__(self, receipt: Path):
        self.receipt = receipt
        self.lock = threading.Lock()
        self.requests = []
        self.stopping = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                if self.path != "/v1/chat/completions":
                    self.send_error(404)
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                users = [m["content"] for m in body.get("messages", []) if m.get("role") == "user"]
                with owner.lock:
                    request = {"stream": body.get("stream") is True, "tools": bool(body.get("tools")), "model": body.get("model"), "lastUserMessage": users[-1] if users else "", "outcome": "pending"}
                    owner.requests.append(request)
                    owner.write_receipt()
                if users and users[-1] == "SHELL AI error":
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":{"message":"QA provider unavailable"}}')
                    owner.finish(request, "failed")
                    return
                if body.get("stream") is not True:
                    self.send_error(400, "This fixture requires the real streaming path")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    if users and users[-1] == "SHELL AI stop":
                        payload = {"choices": [{"index": 0, "delta": {"content": "SHELL AI partial answer"}, "finish_reason": None}]}
                        self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode("utf-8"))
                        self.wfile.flush()
                        # This turn deliberately has no final answer. Only the
                        # client's real transport closure establishes Stop.
                        deadline = time.monotonic() + 30
                        while not owner.stopping.is_set() and time.monotonic() < deadline:
                            readable, _, _ = select.select([self.connection], [], [], 0.1)
                            if readable and not self.connection.recv(1, socket.MSG_PEEK):
                                owner.finish(request, "cancelled")
                                return
                            self.wfile.write(b": waiting for user stop\n\n")
                            self.wfile.flush()
                        owner.finish(request, "unfinished")
                        return
                    for token in ("SHELL AI response ", "中文\n", "Second paragraph"):
                        payload = {"id": "qa-stream", "model": "qa-model", "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}]}
                        self.wfile.write(("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8"))
                        self.wfile.flush()
                        time.sleep(0.15)
                    self.wfile.write(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
                    self.wfile.flush()
                    owner.finish(request, "completed")
                except (BrokenPipeError, ConnectionResetError):
                    owner.finish(request, "cancelled")
                finally:
                    self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"
        self.write_receipt()

    def write_receipt(self):
        self.receipt.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.receipt.with_suffix(".tmp")
        temporary.write_text(json.dumps({"requests": len(self.requests), "streamRequests": sum(r["stream"] for r in self.requests), "toolRequests": sum(r["tools"] for r in self.requests), "cancelledStreams": sum(r["outcome"] == "cancelled" for r in self.requests), "completedStreams": sum(r["outcome"] == "completed" for r in self.requests), "lastUserMessage": self.requests[-1]["lastUserMessage"] if self.requests else "", "model": self.requests[-1]["model"] if self.requests else ""}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.receipt)

    def finish(self, request, outcome):
        with self.lock:
            request["outcome"] = outcome
            self.write_receipt()

    def stop(self):
        self.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def setup(ctx: Any) -> None:
    if ctx.cfg.get("app", {}).get("mode") == "browser":
        seed = json.dumps(json.dumps(config("http://127.0.0.1/unused-browser-stub")))
        ctx.page.context.add_init_script("if (!sessionStorage.getItem('qa.ai.config')) { sessionStorage.setItem('qa.ai.config','true'); localStorage.setItem('taomni.ai.config.v1', " + seed + "); }")
        return
    root = Path(ctx.report_root).resolve()
    expected = native_isolation_env(root)
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("ai_chat_provider requires the current native QA isolation environment")
    provider = ProviderServer(Path(ctx.case_dir) / "ai-provider-requests.json")
    ctx._ai_chat_provider = provider
    try:
        if "NEWMOB_CONFIG_DIR" in expected:
            from native_build import QA_APP_ID
            base = Path(expected["NEWMOB_CONFIG_DIR"]) / QA_APP_ID
        else:
            base = Path(expected["XDG_CONFIG_HOME"])
        target = base / "taomni" / "ai.json"
        if not target.resolve().is_relative_to(root):
            raise RuntimeError("AI fixture config escaped the current run")
        target.parent.mkdir(parents=True, exist_ok=True)
        ctx._ai_config_target = target
        ctx._ai_config_previous = target.read_bytes() if target.exists() else None
        target.write_text(json.dumps(config(provider.base_url)), encoding="utf-8")
        ctx.values["ai_provider_requests"] = provider.receipt.as_posix()
    except BaseException:
        provider.stop()
        raise


def teardown(ctx: Any) -> None:
    provider = getattr(ctx, "_ai_chat_provider", None)
    if provider is not None:
        try:
            provider.stop()
        finally:
            target = getattr(ctx, "_ai_config_target", None)
            if target is not None:
                previous = ctx._ai_config_previous
                if previous is None:
                    target.unlink(missing_ok=True)
                else:
                    target.write_bytes(previous)
