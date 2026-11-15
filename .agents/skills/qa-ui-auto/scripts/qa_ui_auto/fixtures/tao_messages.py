"""Disposable Messages origin/proxies for real Tao IPC and cancellation checks.

Seed only a verified run-owned profile before native startup. The provider is a
loopback protocol fixture; this does not certify a commercial DeepSeek service.
No authorization header or real credential is retained in evidence.
"""
from __future__ import annotations

import json
import os
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        raise RuntimeError("tao_messages verifies native IPC, not browser stubs")
    expected = native_isolation_env(Path(ctx.report_root).resolve())
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Tao fixture requires current-run QA isolation")
    root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    if expected.get("NEWMOB_CONFIG_DIR"):
        root /= QA_APP_ID
    root /= "taomni"
    if root.resolve() != root or not root.is_relative_to(Path(ctx.report_root).resolve()):
        raise RuntimeError("Tao fixture config escaped its run")
    root.mkdir(parents=True, exist_ok=True)
    log = Path(ctx.case_dir) / "tao-messages-events.txt"
    log.write_text("", encoding="utf-8")
    lock, stopping = threading.Lock(), threading.Event()

    def record(text):
        with lock, log.open("a", encoding="utf-8") as output:
            output.write(text + "\n")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def event(self, kind, **data):
            payload = json.dumps(dict(type=kind, **data), ensure_ascii=False)
            self.wfile.write(f"event: {kind}\ndata: {payload}\n\n".encode())
            self.wfile.flush()

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            messages = data.get("messages", [])
            prompt = json.dumps(messages[-1].get("content", []), ensure_ascii=False) if messages else ""
            thinking = data.get("thinking", {}).get("type") == "enabled"
            web = any(tool.get("name") == "deepseek_web_search" for tool in data.get("tools", []))
            route = self.server.route
            record(f"{route} POST {urlsplit(self.path).path} model={data.get('model')} thinking={str(thinking).lower()} web={str(web).lower()} messages={len(messages)}")
            if "QA-SECOND" in prompt:
                previous = json.dumps(messages[:-1], ensure_ascii=False)
                record(f"second-history greeting={'QA-FIRST' in previous} reply={'First reply' in previous} thinking={'private-thinking' in previous}")
            if "QA-FAIL" in prompt:
                payload = b'{"error":{"type":"authentication_error","message":"QA invalid credential"}}'
                self.send_response(401)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.event("message_start", message={"id": "qa-message", "role": "assistant", "model": data.get("model"), "usage": {"input_tokens": 21, "output_tokens": 0}})
                self.event("content_block_start", index=0, content_block={"type": "thinking", "thinking": ""})
                self.event("content_block_delta", index=0, delta={"type": "thinking_delta", "thinking": "private-thinking"})
                self.event("content_block_delta", index=0, delta={"type": "signature_delta", "signature": "qa-valid-signature"})
                self.event("content_block_stop", index=0)
                self.event("content_block_start", index=1, content_block={"type": "text", "text": ""})
                text = "Partial reply" if "QA-SLOW" in prompt else "Second reply" if "QA-SECOND" in prompt else "First reply **streamed**"
                self.event("content_block_delta", index=1, delta={"type": "text_delta", "text": text})
                record("partial-delivered" if "QA-SLOW" in prompt else "first-block-delivered")
                if "QA-SLOW" in prompt:
                    deadline = time.monotonic() + 45
                    while not stopping.wait(.05) and time.monotonic() < deadline:
                        if select.select([self.connection], [], [], 0)[0]:
                            if not self.connection.recv(1, socket.MSG_PEEK):
                                record("slow-network-cancelled")
                                return
                    record("ERROR-slow-not-cancelled")
                else:
                    stopping.wait(.35)
                self.event("content_block_stop", index=1)
                self.event("message_delta", delta={"stop_reason": "end_turn", "title": "QA Tao Greeting"}, usage={"output_tokens": 12})
                self.event("message_stop")
                record("completed")
            except (BrokenPipeError, ConnectionResetError, OSError):
                record("slow-network-cancelled" if "QA-SLOW" in prompt else "network-cancelled")
            finally:
                self.close_connection = True

    servers = []
    for route in ("direct", "app", "custom"):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.route, server.daemon_threads = route, True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    ctx.tao_messages_servers, ctx.tao_messages_stopping = servers, stopping
    direct, app, custom = (server.server_port for server in servers)

    def proxy(port):
        return dict(enabled=True, mode="manual", kind="http", host="127.0.0.1", port=port,
                    username="", password_ref="", session_id="")

    config = dict(asr=dict(active="sensevoice-small", providers={}, warm_on_startup=False, vad="silero", language="auto"),
                  llm=dict(active="deepseek", providers={"deepseek-app": dict(
                      base_url=f"http://127.0.0.1:{direct}", api_key="qa-disposable-loopback-key", model="deepseek-flash",
                      runtime="deepseek-messages", proxy_mode="none", custom_proxy=proxy(custom))},
                           fallback=dict(enabled=False, primary="deepseek", secondary="local", timeout_ms=30000), task_routing={}),
                  full_local_mode=False, fully_disabled=False,
                  deepseek_app=dict(enabled=True, model="deepseek-flash", thinking_default=False, search_default=False,
                                    safety_check_high=True, title_enabled=True, voice_provider="local", tts_voice="stella", cost_confirm_threshold_cny=.5))
    (root / "ai.json").write_text(json.dumps(config), encoding="utf-8")
    (root / "proxy.json").write_text(json.dumps(proxy(app)), encoding="utf-8")
    ctx.values.update(tao_messages_log=str(log), tao_messages_config=str(root / "ai.json"))


def teardown(ctx):
    stopping = getattr(ctx, "tao_messages_stopping", None)
    if stopping:
        stopping.set()
    for server in getattr(ctx, "tao_messages_servers", []):
        server.shutdown()
        server.server_close()
    path = ctx.values.get("tao_messages_log")
    if path and "ERROR-" in Path(path).read_text(encoding="utf-8"):
        raise AssertionError("Tao provider stream remained active after cancellation")
