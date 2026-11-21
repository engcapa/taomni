"""Check the HTTP server opened by the Local servers native case."""

import hashlib
import http.client
import json
from pathlib import Path
import platform
import socket
import subprocess
import time

from .steps import StepError

CASE_ID = "TC-SERVERS-003-tab-functional-native"
SIGNED_CASE_ID = "TC-MODULES-066"
HOST = "127.0.0.1"
PORT = 28489
FILE = "local-servers.txt"
CONTENT = b"Taomni Local servers fixture\n"


def setup(ctx):
    if ctx.case_id not in {CASE_ID, SIGNED_CASE_ID} or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("The HTTP file fixture requires its native Local servers case")
    root = Path(ctx.case_dir).resolve() / "http-docroot"
    root.mkdir()
    (root / FILE).write_bytes(CONTENT)
    ctx.values["local_servers_http_root"] = root.as_posix()


def run(ctx, phase):
    fixture = ctx.fixture_context
    if fixture.case_id not in {CASE_ID, SIGNED_CASE_ID} or not fixture.values.get("local_servers_http_root"):
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
        proof = verify_listener_closed(HOST, PORT)
        outcome = {"listener": False, "proof": proof}
    else:
        raise StepError("Unknown Local HTTP observation phase")
    (ctx.case_dir / f"local-http-{phase}.json").write_text(
        json.dumps({"port": PORT, **outcome}, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified Local HTTP {phase} on {HOST}:{PORT}"


def verify_listener_closed(host, port):
    deadline = time.monotonic() + 5
    while True:
        try:
            with socket.create_connection((host, port), timeout=1):
                pass
        except ConnectionRefusedError:
            return "connection-refused"
        except TimeoutError:
            if platform.system() == "Windows" and not windows_listener_exists(host, port):
                return "absent-from-windows-listener-table"
        if time.monotonic() >= deadline:
            raise StepError(f"Local server at {host}:{port} still accepts connections after Stop")
        time.sleep(0.05)


def windows_listener_exists(host, port):
    output = subprocess.check_output(["netstat.exe", "-ano", "-p", "tcp"], timeout=5)
    listening_addresses = {f"{address}:{port}" for address in (host, "0.0.0.0", "[::]")}
    for line in output.decode("ascii", errors="replace").splitlines():
        fields = line.split()
        if len(fields) == 5 and fields[0] == "TCP" and fields[3] == "LISTENING" and fields[1] in listening_addresses:
            return True
    return False
