"""Run-owned HTTP server that verifies the custom LLM wire protocol."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def setup(ctx):
    log = ctx.case_dir.resolve() / "custom-llm-events.txt"
    log.write_text("", encoding="utf-8")
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            expected_key = "qa-custom-key"
            anthropic = self.path == "/v1/messages"
            responses = self.path == "/v1/responses"
            authorized = (self.headers.get("x-api-key") == expected_key if anthropic
                          else self.headers.get("Authorization") == "Bearer " + expected_key)
            if not authorized:
                self.send_error(401)
                return
            limit = body.get("max_output_tokens" if responses else "max_tokens", body.get("max_completion_tokens"))
            effort = body.get("reasoning", {}).get("effort") or body.get("output_config", {}).get("effort") or body.get("reasoning_effort")
            search = "web_search_options" in body or any(tool.get("type", "").startswith("web_search") for tool in body.get("tools", []))
            with lock, log.open("a", encoding="utf-8") as stream:
                stream.write(f"{self.path} model={body.get('model')} max={limit} effort={effort} search={str(search).lower()} stream={str(bool(body.get('stream'))).lower()}\n")

            message = "Custom provider completed"
            if body.get("stream") and responses:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                frames = [
                    {"type": "response.output_text.delta", "delta": message},
                    {"type": "response.completed", "response": {"model": body["model"], "output": [{"type": "web_search_call"}], "usage": {"input_tokens": 31, "output_tokens": 7}}},
                ]
                for frame in frames:
                    self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
                return

            response = {"model": body["model"]}
            if anthropic:
                response.update(content=[{"type": "text", "text": message}], usage={"input_tokens": 3, "output_tokens": 2})
            elif responses:
                response.update(status="completed", output=[{"type": "message", "content": [{"type": "output_text", "text": message}]}])
            else:
                response.update(choices=[{"message": {"content": message}}])
            payload = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    ctx.tao_custom_llm_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    ctx.tao_custom_llm_server.daemon_threads = True
    threading.Thread(target=ctx.tao_custom_llm_server.serve_forever, daemon=True).start()
    ctx.values.update(tao_custom_llm_url=f"http://127.0.0.1:{ctx.tao_custom_llm_server.server_port}/v1", tao_custom_llm_log=str(log))


def teardown(ctx):
    server = getattr(ctx, "tao_custom_llm_server", None)
    if server:
        server.shutdown()
        server.server_close()
