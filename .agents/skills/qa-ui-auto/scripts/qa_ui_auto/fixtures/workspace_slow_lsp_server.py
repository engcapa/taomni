"""Minimal real LSP peer; stdout contains only framed JSON-RPC messages."""
import json
from pathlib import Path
import sys
import time


def serve(events: Path, gate: Path, documents: Path | None = None):
    def log(message):
        with events.open("a", encoding="utf-8") as stream:
            stream.write(message + "\n")

    def reply(identifier, result):
        payload = json.dumps({"jsonrpc": "2.0", "id": identifier, "result": result}).encode()
        sys.stdout.buffer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
        sys.stdout.buffer.flush()

    while True:
        headers = {}
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return
            if line in (b"\r\n", b"\n"):
                break
            name, value = line.decode().split(":", 1)
            headers[name.lower()] = value.strip()
        message = json.loads(sys.stdin.buffer.read(int(headers["content-length"])))
        method = message.get("method")
        if documents is not None and method in {
            "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose",
        }:
            # Synthetic fixture buffers only. This independent peer is never
            # connected to a personal project/profile.
            with documents.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(message) + "\n")
        if method == "exit":
            return
        if method == "initialize":
            log("initialize-blocked")
            deadline = time.monotonic() + 60
            while not gate.exists():
                if time.monotonic() >= deadline:
                    log("initialize-timeout")
                    return
                time.sleep(.025)
            log("initialize-released")
            reply(message["id"], {"capabilities": {"textDocumentSync": {"openClose": True, "change": 1}}})
        elif method == "textDocument/didOpen":
            log("didOpen:" + message["params"]["textDocument"]["uri"])
        elif method == "textDocument/didClose":
            log("didClose:" + message["params"]["textDocument"]["uri"])
        elif "id" in message:
            reply(message["id"], None)


if __name__ == "__main__":
    serve(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None)
