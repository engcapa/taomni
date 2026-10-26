"""Distinguish a held real LSP peer from a stubbed or pre-completed session."""
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from qa_ui_auto.fixtures import workspace_slow_lsp_server


class SlowLspPeerTest(unittest.TestCase):
    def test_initialize_waits_for_gate_and_observes_actual_document_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix="slow-lsp-test-") as directory:
            root = Path(directory)
            events, gate = root / "events.txt", root / "release.txt"
            with subprocess.Popen(
                [sys.executable, workspace_slow_lsp_server.__file__, str(events), str(gate)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ) as process:
                replies = queue.Queue()

                def read_reply():
                    headers = {}
                    while True:
                        line = process.stdout.readline()
                        if not line:
                            replies.put(RuntimeError("peer exited without initialize response"))
                            return
                        if line == b"\r\n":
                            break
                        key, value = line.decode().split(":", 1)
                        headers[key.lower()] = value.strip()
                    replies.put(json.loads(process.stdout.read(int(headers["content-length"]))))

                def send(message):
                    payload = json.dumps({"jsonrpc": "2.0", **message}).encode()
                    process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
                    process.stdin.flush()

                def log_contains(expected):
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if events.exists() and expected in events.read_text():
                            return
                        time.sleep(.01)
                    self.fail(f"Missing peer event: {expected}")

                try:
                    reader = threading.Thread(target=read_reply, daemon=True)
                    reader.start()
                    send({"id": 1, "method": "initialize", "params": {}})
                    log_contains("initialize-blocked")
                    with self.assertRaises(queue.Empty):
                        replies.get(timeout=.1)
                    self.assertNotIn("initialize-released", events.read_text())
                    gate.write_text("release")
                    reply = replies.get(timeout=5)
                    self.assertIsInstance(reply, dict)
                    self.assertEqual(reply["id"], 1)
                    self.assertTrue(reply["result"]["capabilities"]["textDocumentSync"]["openClose"])
                    reader.join(timeout=5)
                    send({"method": "textDocument/didOpen", "params": {"textDocument": {"uri": "file:///fixture/src/index.ts"}}})
                    log_contains("didOpen:file:///fixture/src/index.ts")
                    send({"method": "textDocument/didClose", "params": {"textDocument": {"uri": "file:///fixture/src/index.ts"}}})
                    log_contains("didClose:file:///fixture/src/index.ts")
                    send({"method": "exit"})
                    process.wait(timeout=5)
                    self.assertEqual(process.returncode, 0, process.stderr.read().decode())
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
