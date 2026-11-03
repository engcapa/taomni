#!/usr/bin/env python3
"""Loopback-only fixture LLM. Run in CI; local tests call the pure dispatch API."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import threading
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qsl, urlsplit

# Executable with python -I: only this trusted, in-repository module directory
# is added back, never the cwd, downloaded archives, or a worker worktree.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavior import FixtureError, MODEL_IDS, WORKER_MARKER, decide, metadata, safe_id
from protocols import compact, json_response, stream_response
from diagnostics import request_diagnostic
from receipts import is_linked_worktree

PATH_PROTOCOL = {"/v1/messages": "anthropic_messages", "/v1/chat/completions": "openai_chat",
                 "/v1/responses": "openai_responses"}
MAX_REQUEST_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict | Iterable[bytes]
    streaming: bool = False


class FixtureApplication:
    """Request decisions and sanitized receipts, separated from HTTP lifetime."""

    def __init__(self, request_log: Path, worker_roots: dict[str, Path] | None = None):
        self.request_log = request_log
        self.worker_roots = dict(worker_roots or {})
        self.allowed_worker_roots: list[Path] = []
        self.lock = threading.Lock()
        self.sequence = 0
        self.events: list[dict] = []
        request_log.parent.mkdir(parents=True, exist_ok=True)
        request_log.touch(mode=0o600, exist_ok=False)

    def record(self, **event) -> None:
        # Never include headers, request text, tool args/results, arbitrary URLs,
        # exception strings, environment variables or raw model IDs in receipts.
        with self.lock:
            self.sequence += 1
            entry = {"sequence": self.sequence, **event}
            self.events.append(entry)
            with self.request_log.open("a", encoding="utf-8") as output:
                output.write(compact(entry) + "\n")

    def allow_worker_root(self, root: Path) -> None:
        """Called only by trusted QA setup, never through an HTTP admin route."""
        if not root.is_absolute() or root.resolve() != root:
            raise ValueError("worker root must be a physical absolute QA directory")
        with self.lock:
            self.allowed_worker_roots.append(root)

    def register_request_worker(self, body: dict) -> dict[str, Path]:
        worker = metadata(body, WORKER_MARKER)
        if worker:
            safe_id(worker.get("worker_id"), "worker_id")
        with self.lock:
            if worker and worker.get("worker_id") in self.worker_roots and "worktree" in worker:
                if str(self.worker_roots[worker["worker_id"]]) != worker["worktree"]:
                    raise FixtureError("worker identity cannot be reassigned to another worktree")
            if worker and worker.get("worker_id") not in self.worker_roots:
                worker_id = safe_id(worker.get("worker_id"), "worker_id")
                raw_path = worker.get("worktree")
                path = Path(raw_path) if isinstance(raw_path, str) else None
                if (path is None or not is_linked_worktree(path)
                        or not any(path != root and path.is_relative_to(root) for root in self.allowed_worker_roots)):
                    raise FixtureError("worker worktree is outside the trusted QA owner root")
                if path in self.worker_roots.values():
                    raise FixtureError("worker worktree is already assigned to another owner")
                self.worker_roots[worker_id] = path
            return dict(self.worker_roots)

    def dispatch(self, method: str, path: str, body: dict | None = None) -> Reply:
        # Anthropic SDKs send the documented beta query on Messages requests.
        # Normalize that one closed-set query, never arbitrary query routes or
        # absolute proxy URLs. Receipts never retain caller-controlled queries.
        parsed = urlsplit(path)
        if (not parsed.scheme and not parsed.netloc and not parsed.fragment
                and parsed.path in {"/v1/messages", "/v1/messages/count_tokens"}
                and parse_qsl(parsed.query, keep_blank_values=True) == [("beta", "true")]):
            path = parsed.path
        # Reject version duplication and unsupported routes rather than silently
        # masking client configuration mistakes.
        if path not in (*PATH_PROTOCOL, "/v1/models", "/v1/messages/count_tokens", "/health"):
            self.record(method=method, route="unknown", status=404)
            return Reply(404, {"error": {"type": "not_found", "message": "unknown fixture route"}})
        if method == "GET" and path == "/health":
            return Reply(200, {"status": "ready", "fixture": "taomni-orchestration"})
        if method == "GET" and path == "/v1/models":
            self.record(method=method, route="models", status=200)
            return Reply(200, {"object": "list", "data": [
                {"id": model, "object": "model", "created": 1700000000, "owned_by": "taomni-fixture",
                 "type": "model", "display_name": model} for model in MODEL_IDS],
                "has_more": False, "first_id": MODEL_IDS[0], "last_id": MODEL_IDS[-1]})
        if method != "POST" or not isinstance(body, dict):
            return Reply(400, {"error": {"type": "invalid_request_error", "message": "expected JSON POST"}})
        if path == "/v1/messages/count_tokens":
            self.record(method=method, route="count_tokens", status=200)
            return Reply(200, {"input_tokens": 128})
        if path not in PATH_PROTOCOL:
            return Reply(405, {"error": {"type": "invalid_request_error", "message": "method not allowed"}})
        protocol = PATH_PROTOCOL[path]
        request_id = "req_fixture_" + uuid.uuid4().hex
        try:
            decision = decide(body, protocol, self.register_request_worker(body))
        except FixtureError as exc:
            diagnostic = request_diagnostic(body)
            self.record(method=method, route=protocol, status=422, error="unsupported_fixture_request",
                        request_id=request_id, streaming=body.get("stream") is True,
                        request_sha256=hashlib.sha256(compact(body).encode()).hexdigest(),
                        worker_digest=diagnostic.get("worker_digest"), diagnostic=diagnostic, **exc.diagnostic)
            return Reply(422, {"error": {"type": "invalid_request_error", "code": exc.diagnostic["error_code"],
                                         "message": "unsupported fixture request; inspect manifest/tool configuration"}})
        model = body.get("model", "fixture-complete")
        # Approved tool names are a closed set; worker identity is logged as a
        # digest so even caller-controlled metadata cannot inject secrets.
        receipt = dict(method=method, route=protocol, request_id=request_id,
                       streaming=body.get("stream") is True, scenario=decision.scenario,
                       request_sha256=hashlib.sha256(compact(body).encode()).hexdigest(),
                       worker_digest=hashlib.sha256(decision.worker_id.encode()).hexdigest() if decision.worker_id else None,
                       tool_name=decision.tool_name, tool_call_id=decision.call_id,
                       tool_result_seen=decision.tool_result_seen,
                       diagnostic=request_diagnostic(body) if decision.worker_id else None)
        status = 503 if decision.scenario == "http-error" else 200
        self.record(status=status, **receipt)
        if status == 503:
            return Reply(status, {"error": {"type": "api_error", "message": "intentional fixture HTTP failure"}})
        if body.get("stream") is True:
            return Reply(200, stream_response(protocol, model, decision, request_id), True)
        if decision.scenario == "error":
            return Reply(500, {"error": {"type": "api_error", "message": "intentional fixture failure"}})
        return Reply(200, json_response(protocol, model, decision, request_id))


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # BaseHTTPRequestHandler logs arbitrary paths and errors.

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def send_reply(self, reply: Reply) -> None:
        self.send_response(reply.status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("x-request-id", "fixture")
        self.send_header("Cache-Control", "no-store")
        if reply.streaming:
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            for frame in reply.body:
                # Also fragment the HTTP write independently of SSE boundaries.
                for start in range(0, len(frame), 113):
                    self.wfile.write(frame[start:start + 113])
                    self.wfile.flush()
            self.close_connection = True
        else:
            data = compact(reply.body).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.send_reply(self.server.application.dispatch("GET", self.path))

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST_BYTES or self.headers.get("Transfer-Encoding"):
                raise ValueError("invalid length")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("expected object")
        except (ValueError, UnicodeError):
            self.close_connection = True
            self.send_reply(Reply(400, {"error": {"type": "invalid_request_error",
                                                  "message": "invalid bounded JSON body"}}))
            return
        self.send_reply(self.server.application.dispatch("POST", self.path, body))

    def do_CONNECT(self):
        self.close_connection = True
        self.send_reply(Reply(403, {"error": {"message": "fixture never proxies external traffic"}}))


@dataclass
class RunningFixture:
    server: ThreadingHTTPServer
    thread: threading.Thread
    application: FixtureApplication

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError("fixture server failed to stop")


def start_fixture(request_log: Path, worker_roots: dict[str, Path] | None = None,
                  port: int = 0) -> RunningFixture:
    app = FixtureApplication(request_log, worker_roots)
    server = ThreadingHTTPServer(("127.0.0.1", port), FixtureHandler)
    server.daemon_threads = True
    server.application = app
    thread = threading.Thread(target=server.serve_forever, name="orchestration-fixture", daemon=True)
    thread.start()
    return RunningFixture(server, thread, app)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-log", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if args.ready_file.exists():
        parser.error("ready file already exists")
    running = start_fixture(args.request_log, port=args.port)
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    args.ready_file.parent.mkdir(parents=True, exist_ok=True)
    args.ready_file.write_text(compact({"base_url": running.base_url,
                                        "request_log": str(args.request_log.resolve()),
                                        "pid": os.getpid()}) + "\n", encoding="utf-8")
    try:
        stopped.wait()
    finally:
        running.close()
        args.ready_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
