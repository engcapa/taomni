import base64
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase

from qa_ui_auto.browser_evidence import BrowserEvidence, traces_ssh_terminal


class Emitter:
    def __init__(self, **attributes):
        self.__dict__.update(attributes)
        self.handlers = {}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)

    def remove_listener(self, event, handler):
        self.handlers[event].remove(handler)

    def emit(self, event, payload):
        for handler in list(self.handlers.get(event, [])):
            handler(payload)


class BrowserEvidenceTest(TestCase):
    def test_both_ssh_fixtures_keep_passive_transport_evidence(self):
        for fixture in ("ssh_required", "ssh_posix_required"):
            self.assertTrue(traces_ssh_terminal(["reset_db", fixture]))
        self.assertFalse(traces_ssh_terminal(["reset_db", "sftp_required"]))
        self.assertFalse(traces_ssh_terminal([]))

    def test_console_and_errors_retain_original_content_and_detach(self):
        with TemporaryDirectory() as directory:
            page = Emitter()
            console = []
            evidence = BrowserEvidence(page, console, Path(directory))
            page.emit("console", SimpleNamespace(type="warning", text="original warning"))
            page.emit("pageerror", ValueError("original failure"))
            self.assertEqual(console, [{"level": "warning", "text": "original warning"},
                                       {"level": "error", "text": "pageerror: original failure"}])
            evidence.close()
            self.assertTrue(all(not handlers for handlers in page.handlers.values()))
            self.assertFalse(list(Path(directory).iterdir()))

    def test_passive_frames_preserve_full_input_and_order_without_auth(self):
        with TemporaryDirectory() as directory:
            page = Emitter()
            evidence = BrowserEvidence(page, [], Path(directory), trace_terminal=True)
            ignored = Emitter(url="ws://localhost/__taomni/sftp-bridge")
            page.emit("websocket", ignored)
            self.assertFalse(ignored.handlers)
            socket = Emitter(url="ws://localhost/__taomni/ssh-bridge")
            delivered = []
            socket.on("framesent", delivered.append)
            page.emit("websocket", socket)
            socket.emit("framesent", json.dumps({"type": "connect", "authData": "never record"}))
            command = b"echo qa-ssh-with-sftp-open"
            wire = json.dumps({"type": "data", "data": base64.b64encode(command).decode()})
            socket.emit("framesent", wire)
            socket.emit("framesent", json.dumps({"type": "resize", "rows": 24, "cols": 80}))
            socket.emit("framereceived", json.dumps({"type": "output", "data": "G1s2bg=="}))
            evidence.close()
            result = json.loads(Path(directory, "terminal-transport.json").read_text())
            self.assertEqual(result["total_frames"], 3)
            self.assertEqual([row["sequence"] for row in result["frames"]], [1, 2, 3])
            self.assertEqual([row["direction"] for row in result["frames"]], ["sent", "sent", "received"])
            self.assertEqual(base64.b64decode(result["frames"][0]["data_base64"]), command)
            self.assertEqual(result["frames"][0]["sha256"], hashlib.sha256(command).hexdigest())
            self.assertEqual(delivered[1], wire)
            self.assertNotIn("never record", json.dumps(result))
            self.assertEqual(socket.handlers["framesent"], [delivered.append])
            socket.emit("framesent", "after diagnostic cleanup")
            self.assertEqual(delivered[-1], "after diagnostic cleanup")

    def test_ring_and_payloads_are_bounded_and_malformed_frames_are_ignored(self):
        with TemporaryDirectory() as directory:
            page = Emitter()
            evidence = BrowserEvidence(page, [], Path(directory), trace_terminal=True)
            socket = Emitter(url="ws://localhost/__taomni/ssh-bridge")
            page.emit("websocket", socket)
            for invalid in ("{", "null", "[]", '{"type":"data","data":"!"}',
                            '{"type":"resize","rows":true,"cols":80}'):
                socket.emit("framesent", invalid)
            self.assertEqual(evidence.sequence, 0)
            for _ in range(200):
                socket.emit("framereceived", '{"type":"ready"}')
            raw = b"a" * 5000 + b"tail"
            socket.emit("framereceived", json.dumps({"type": "output", "data": base64.b64encode(raw).decode()}))
            evidence.close()
            result = json.loads(Path(directory, "terminal-transport.json").read_text())
            self.assertEqual(result["total_frames"], 201)
            self.assertEqual(len(result["frames"]), BrowserEvidence.FRAME_LIMIT)
            row = result["frames"][-1]
            self.assertEqual(row["bytes"], len(raw))
            self.assertEqual(row["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertTrue(row["truncated"])
            self.assertTrue(base64.b64decode(row["tail_base64"]).endswith(b"tail"))
            self.assertEqual(len(base64.b64decode(row["head_base64"])) +
                             len(base64.b64decode(row["tail_base64"])), BrowserEvidence.BYTE_LIMIT)
