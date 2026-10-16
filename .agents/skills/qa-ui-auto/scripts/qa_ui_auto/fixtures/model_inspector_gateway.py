"""Loopback HTTP/proxy fixture; real Tauri IPC, no provider credentials or internet.

Three listeners distinguish application proxy, independent proxy and direct I/O.
CONNECT is refused (never tunneled); a controlled pending CONNECT reproduces the
metadata → provider-list policy race. Only sanitized method/path/model is logged.
"""
from __future__ import annotations

import hashlib
import json
import os
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from tauri_webdriver import native_isolation_env
from native_build import QA_APP_ID


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        raise RuntimeError("model_inspector_gateway requires native IPC")
    expected = native_isolation_env(Path(ctx.report_root).resolve())
    if any(os.environ.get(k) != v for k, v in expected.items()):
        raise RuntimeError("Missing current-run isolation")
    root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    if expected.get("NEWMOB_CONFIG_DIR"):
        root = root / QA_APP_ID
    root = root / "taomni"
    if root.resolve() != root or not root.is_relative_to(Path(ctx.report_root).resolve()):
        raise RuntimeError("Fixture config escaped the QA run")
    root.mkdir(parents=True, exist_ok=True)
    events = Path(ctx.case_dir) / "gateway-events.txt"
    control = Path(ctx.case_dir) / "gateway-control.txt"
    events.write_text("", encoding="utf-8")
    control.write_text("normal", encoding="utf-8")
    lock = threading.Lock()

    def record(line):
        with lock, events.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_CONNECT(self):
            if control.read_text(encoding="utf-8") == "hold-metadata":
                record("metadata-pending")
                end = time.monotonic() + 20
                while time.monotonic() < end:
                    if select.select([self.connection], [], [], .05)[0]:
                        if not self.connection.recv(1, socket.MSG_PEEK):
                            record("metadata-cancelled")
                            return
                record("metadata-timeout")
            self.reply(502, {"error": "fixture blocks external TLS"})

        def do_GET(self):
            path = urlsplit(self.path).path
            if control.read_text(encoding="utf-8") == "hold-metadata":
                record("ERROR-list-after-policy-metadata-cancel")
            record(f"{self.server.route} GET {path}")
            self.reply(200, {"data": [{"id": "catalog-model"}, {"id": "kimi-k2.6"}]})

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            model = data.get("model", "")
            record(f"{self.server.route} POST {urlsplit(self.path).path} {model}")
            if model == "fail-model":
                self.reply(502, {"error": "configured proxy failed"})
            else:
                self.reply(200, {"choices": [{"message": {"role": "assistant", "content": "pong"}}]})

    servers = []
    for route in ["app", "custom", "direct"]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        server.route = route
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    ctx.model_inspector_servers = servers
    app, custom, direct = [s.server_port for s in servers]

    def proxy(port):
        return dict(enabled=True, mode="manual", kind="http", host="127.0.0.1", port=port,
                    session_id="", username="", password_ref="")

    def provider(runtime, mode="app"):
        return dict(base_url=f"http://127.0.0.1:{direct}/v1", api_key="", model="catalog-model",
                    runtime=runtime, proxy_mode=mode, custom_proxy=proxy(custom))

    config = dict(full_local_mode=False, fully_disabled=False,
                  asr=dict(active="sensevoice-small", providers={}, warm_on_startup=False, vad="silero", language="auto"),
                  llm=dict(active="deepseek", providers={"deepseek": provider("openai-compat"),
                          "local": provider("llama-server", "none"), "opencode-go": provider("opencode-go")},
                           fallback=dict(enabled=False, primary="deepseek", secondary="local", timeout_ms=30000), task_routing={}))
    (root / "ai.json").write_text(json.dumps(config), encoding="utf-8")
    (root / "proxy.json").write_text(json.dumps(proxy(app)), encoding="utf-8")
    providers = {"deepseek": {"models": {"catalog-model": {"tool_call": False}}}, "opencode-go": {"models": {}}}
    encoded = json.dumps(providers, sort_keys=True, separators=(",", ":")).encode()
    cache = dict(providers=providers, fetched_at=int(time.time()), source="cache", last_error=None,
                 digest=hashlib.sha256(encoded).hexdigest())
    (root / "model-catalog.json").write_text(json.dumps(cache), encoding="utf-8")
    ctx.values.update(inspector_events=str(events), inspector_control=str(control),
                      inspector_config=str(root / "ai.json"), inspector_config_hash=hashlib.sha256((root / "ai.json").read_bytes()).hexdigest(), inspector_results=str(root / "model-check-results.json"),
                      inspector_draft_base=f"http://127.0.0.1:{direct}/draft/v1")


def teardown(ctx):
    for server in getattr(ctx, "model_inspector_servers", []):
        server.shutdown()
        server.server_close()
    events = Path(ctx.values["inspector_events"]).read_text(encoding="utf-8")
    if "ERROR-list-after-policy-metadata-cancel" in events or "direct POST /draft/v1/chat/completions fail-model" in events:
        raise AssertionError("Network policy or configured proxy fell back to direct I/O")
