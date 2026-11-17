"""Configured ordinary LLM protocol fixture; never contacts a commercial service.

Records wire models, history and actual network cancellation, without retaining
headers or credentials. Only the current isolated QA profile is seeded.
"""
from __future__ import annotations

import json
import os
import platform
from pathlib import Path
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env


def setup(ctx):
    expected = native_isolation_env(Path(ctx.report_root).resolve())
    if ctx.cfg["app"]["mode"] != "native" or any(os.environ.get(k) != v for k, v in expected.items()):
        raise RuntimeError("Ordinary LLM fixture requires this run's isolated native profile")
    root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    if expected.get("NEWMOB_CONFIG_DIR"):
        root /= QA_APP_ID
    root = root / "taomni"
    root.mkdir(parents=True, exist_ok=True)
    if not root.resolve().is_relative_to(Path(ctx.report_root).resolve()):
        raise RuntimeError("Ordinary LLM fixture escaped QA isolation")
    log = Path(ctx.case_dir).resolve() / "ordinary-llm-events.txt"
    log.write_text("", encoding="utf-8")
    lock, stopping = threading.Lock(), threading.Event()

    def record(message):
        with lock, log.open("a", encoding="utf-8") as stream:
            stream.write(message + "\n")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_frame(self, value):
            self.wfile.write(("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            messages = body.get("messages", [])
            prompt = json.dumps(messages[-1].get("content"), ensure_ascii=False) if messages else ""
            previous = json.dumps(messages[:-1], ensure_ascii=False)
            path = urlsplit(self.path).path
            standard = not any(k in body for k in ("thinking", "reasoning_effort", "tools", "safety_check"))
            record(f"POST {path} model={body.get('model')} standard={str(standard).lower()} history={str('Ordinary first reply' in previous).lower()}")
            if "QA-LLM-FAIL" in prompt:
                self.send_error(401)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            anthropic = path.endswith("/messages")
            text = "Ordinary first reply" if "QA-LLM-FIRST" in prompt else "Ordinary follow-up reply"
            if "QA-LLM-ATTACH" in prompt:
                if "QA_ATTACHMENT_VALUE=73" not in prompt:
                    text = "ERROR: document content is missing"
                else:
                    record("document-bytes-verified")
                    text = "Document value is 73"
            if "QA-LLM-SLOW" in prompt:
                text = "Ordinary partial reply"
            try:
                if anthropic:
                    self.send_frame(dict(type="message_start", message=dict(model=body["model"], usage=dict(input_tokens=23))))
                    self.send_frame(dict(type="content_block_start", index=0, content_block=dict(type="text", text="")))
                    self.send_frame(dict(type="content_block_delta", index=0, delta=dict(type="text_delta", text=text)))
                else:
                    self.send_frame(dict(choices=[dict(delta=dict(content=text), finish_reason=None)]))
                if "QA-LLM-SLOW" in prompt:
                    record("partial-delivered")
                    deadline = time.monotonic() + 30
                    while not stopping.wait(.05) and time.monotonic() < deadline:
                        if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                            record("network-cancelled")
                            return
                    record("ERROR: slow request was not cancelled")
                if anthropic:
                    self.send_frame(dict(type="content_block_stop", index=0))
                    self.send_frame(dict(type="message_delta", delta=dict(stop_reason="end_turn"), usage=dict(output_tokens=11)))
                    self.send_frame(dict(type="message_stop"))
                else:
                    self.send_frame(dict(choices=[dict(delta={}, finish_reason="stop")]))
                    self.send_frame(dict(choices=[], usage=dict(prompt_tokens=23, completion_tokens=11)))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                record("completed")
            except (OSError, BrokenPipeError, ConnectionResetError):
                record("network-cancelled")
            finally:
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ctx.tao_llm_server, ctx.tao_llm_stopping = server, stopping
    base = f"http://127.0.0.1:{server.server_port}/v1"

    def provider(runtime, model):
        return dict(base_url=base, api_key="", model=model, runtime=runtime, proxy_mode="none")

    config = dict(
        asr=dict(active="sensevoice-small", providers={}, warm_on_startup=False, vad="silero", language="auto"),
        llm=dict(active="qa-openai", providers={
            "qa-openai": provider("openai-compat", "qa-chat-v1"),
            "qa-anthropic": provider("anthropic", "qa-messages-v1"),
            "qa-local": provider("llama-server", "qa-local-v1"),
            "claude-code": provider("openai-compat", "harness-must-be-excluded"),
            "qa-media-only": {**provider("openai-compat", "image"), "capabilities": dict(chat=False, image_generation=True)},
        }, fallback=dict(enabled=False, primary="qa-openai", secondary="qa-local", timeout_ms=30000), task_routing={}),
        deepseek_app=dict(enabled=True, provider="qa-openai", model="qa-chat-v1", thinking_default=False,
                          search_default=False, safety_check_high=True, title_enabled=True, voice_provider="local",
                          tts_voice="stella", cost_confirm_threshold_cny=.5),
    )
    (root / "ai.json").write_text(json.dumps(config), encoding="utf-8")
    document = Path(ctx.case_dir).resolve() / "ordinary-document.txt"
    document.write_text("QA_ATTACHMENT_VALUE=73\n", encoding="utf-8")
    # The hosted Windows image uses an English Common Item Dialog. Keep its
    # exact title and executable ownership checks; local OS locales may opt in.
    chooser_title = os.environ.get("TAOMNI_QA_FILE_DIALOG_TITLE") or ("Open File" if platform.system() == "Linux" else "Open")
    ctx.values.update(tao_llm_log=str(log), tao_llm_document=str(document), tao_llm_chooser_title=chooser_title)


def teardown(ctx):
    stopping = getattr(ctx, "tao_llm_stopping", None)
    if stopping:
        stopping.set()
    server = getattr(ctx, "tao_llm_server", None)
    if server:
        server.shutdown()
        server.server_close()
