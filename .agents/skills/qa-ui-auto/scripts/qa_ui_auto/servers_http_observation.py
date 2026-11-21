"""Check the HTTP server opened by the Local servers native case."""

import hashlib
import http.client
import json
from pathlib import Path
import socket
import time

from .steps import StepError

CASE_ID = "TC-SERVERS-003-tab-functional-native"
HOST = "127.0.0.1"
PORT = 28489
FILE = "local-servers.txt"
CONTENT = b"Taomni Local servers fixture\n"


def setup(ctx):
    if ctx.case_id != CASE_ID or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("The HTTP file fixture requires its native Local servers case")
    root = Path(ctx.case_dir).resolve() / "http-docroot"
    root.mkdir()
    (root / FILE).write_bytes(CONTENT)
    ctx.values["local_servers_http_root"] = root.as_posix()


def run(ctx, phase):
    fixture = ctx.fixture_context
    if fixture.case_id != CASE_ID or not fixture.values.get("local_servers_http_root"):
        raise StepError("The HTTP observation requires its native Local servers fixture")
    if phase == "serving":
        connection = http.client.HTTPConnection(HOST, PORT, timeout=3)
        try:
            connection.request("GET", "/" + FILE)
            response = connection.getresponse()
            body = response.read(len(CONTENT) + 1)
            if response.status != 200 or body != CONTENT:
                raise StepError(f"Local HTTP returned {response.status} or different file bytes")
            outcome = {"status": response.status, "sha256": hashlib.sha256(body).hexdigest()}
        finally:
            connection.close()
    elif phase == "stopped":
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection((HOST, PORT), timeout=1):
                    pass
            except ConnectionRefusedError:
                outcome = {"listener": False}
                break
            if time.monotonic() >= deadline:
                raise StepError("Local HTTP still accepts connections after Stop")
            time.sleep(0.05)
    else:
        raise StepError("Unknown Local HTTP observation phase")
    (ctx.case_dir / f"local-http-{phase}.json").write_text(
        json.dumps({"port": PORT, **outcome}, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified Local HTTP {phase} on {HOST}:{PORT}"
