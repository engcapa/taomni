"""A loopback download origin owned by one native case, with real Range bytes.

No registry, trust anchor or active pointer is seeded. The case starts a fixed
package transfer through production IPC; cancellation/resume use Settings.
"""
from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import threading

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from ..steps import StepError

PAYLOAD = bytes(range(251)) * 2048
CHUNK = 8192
TASK_ID = "qa-module-download"


def range_offset(value, size):
    if value is None:
        return 0
    if not value.startswith("bytes=") or not value.endswith("-") or not value[6:-1].isdigit():
        raise ValueError("Expected one open-ended byte Range")
    offset = int(value[6:-1])
    if not 0 < offset < size:
        raise ValueError("Range must refer to an existing incomplete prefix")
    return offset


def plugin_root(ctx):
    owner = getattr(ctx, "fixture_context", None) or ctx
    report_root = getattr(owner, "report_root", None)
    if report_root is None:
        raise StepError("Module download observation requires its run-owned fixture context")
    isolation = native_isolation_env(Path(report_root))
    if any(os.environ.get(key) != value for key, value in isolation.items()):
        raise StepError("Module download case requires its verified isolated QA profile")
    data = Path(isolation.get("NEWMOB_DATA_DIR") or isolation["XDG_DATA_HOME"]) / QA_APP_ID
    root = (data / "plugins").absolute()
    if root.resolve() != root or not root.is_relative_to(Path(ctx.case_dir).resolve().parent):
        raise StepError("Module download fixture escaped the run-owned profile")
    return root


class Origin:
    def __init__(self, evidence):
        self.finish = threading.Event()
        self.advance = threading.Event()
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.requests = []
        self.evidence = evidence
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path != "/module.pkg":
                    self.send_error(404)
                    return
                try:
                    offset = range_offset(self.headers.get("Range"), len(PAYLOAD))
                except ValueError:
                    self.send_error(416)
                    return
                record = {"range": self.headers.get("Range"), "offset": offset, "disconnected": False}
                with owner.lock:
                    owner.requests.append(record)
                    owner.save()
                self.send_response(206 if offset else 200)
                self.send_header("Content-Length", str(len(PAYLOAD) - offset))
                self.send_header("Connection", "close")
                if offset:
                    self.send_header("Content-Range", f"bytes {offset}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
                self.end_headers()
                try:
                    cursor = min(offset + CHUNK, len(PAYLOAD))
                    self.wfile.write(PAYLOAD[offset:cursor])
                    self.wfile.flush()
                    self.connection.settimeout(.05)
                    advanced = False
                    while not owner.stop.is_set() and not owner.finish.is_set():
                        if owner.advance.is_set() and not advanced:
                            end = min(cursor + CHUNK, len(PAYLOAD))
                            self.wfile.write(PAYLOAD[cursor:end])
                            self.wfile.flush()
                            cursor = end
                            advanced = True
                        try:
                            if self.connection.recv(1) == b"":
                                record["disconnected"] = True
                                break
                            raise RuntimeError("Unexpected client bytes after the GET request")
                        except socket.timeout:
                            continue
                    if owner.finish.is_set() and not owner.stop.is_set() and not record["disconnected"]:
                        self.wfile.write(PAYLOAD[cursor:])
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    record["disconnected"] = True
                finally:
                    with owner.lock:
                        owner.save()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start()

    def save(self):
        self.evidence.write_text(json.dumps(self.requests, indent=2), encoding="utf-8")

    def records(self):
        with self.lock:
            return [dict(row) for row in self.requests]

    def close(self):
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def state(ctx):
    owner = getattr(ctx, "fixture_context", None) or ctx
    value = getattr(owner, "module_download", None)
    if not isinstance(value, Origin):
        raise StepError("module_download_probe requires its native module_download fixture")
    return value


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise StepError("module_download runs only in native; browser models cannot prove real networking")
    root = plugin_root(ctx)
    ctx.module_download = Origin(Path(ctx.case_dir) / "module-download-origin.json")
    (Path(ctx.case_dir) / "module-download-fixture.json").write_text(json.dumps({
        "pluginRoot": str(root), "size": len(PAYLOAD), "sha256": hashlib.sha256(PAYLOAD).hexdigest(),
    }, indent=2), encoding="utf-8")


def teardown(ctx):
    state(ctx).close()
