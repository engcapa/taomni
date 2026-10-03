"""The per-case VNC fixture contract and the browser host-file verbs it relies on."""
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto.fixtures import FixtureSkip, ard_required, vnc_required
from qa_ui_auto.steps import REGISTRY, StepContext, StepError


class FakeFixture:
    """Listens like vnc_fixture_server.py: an RFB port and a line-command port."""

    def __init__(self, reply="ok"):
        self.commands = []
        self.reply = reply
        self.rfb = socket.create_server(("127.0.0.1", 0))
        self.control = socket.create_server(("127.0.0.1", 0))
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        conn, _ = self.control.accept()
        with conn:
            data = b""
            while chunk := conn.recv(65536):
                data += chunk
            lines = data.decode().splitlines()
            self.commands.extend(lines)
            conn.sendall(("\n".join(self.reply for _ in lines) + "\n").encode())

    def ports(self):
        return self.rfb.getsockname()[1], self.control.getsockname()[1]

    def close(self):
        self.rfb.close()
        self.control.close()


def context(root, cfg, env=None):
    return SimpleNamespace(case_id="TC-vnc", case_dir=root / "TC-vnc", cfg=cfg, env=env or {}, values={})


class VncRequiredTest(unittest.TestCase):
    def test_skips_without_a_configured_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(FixtureSkip, "vnc.host"):
                vnc_required.setup(context(Path(directory), {}))

    def test_skips_without_the_password(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=False) as env:
            env.pop("QA_VNC_PASSWORD", None)
            cfg = {"vnc": {"host": "127.0.0.1", "port": 1, "control_port": 2, "password": "${env.QA_VNC_PASSWORD}"}}
            with self.assertRaisesRegex(FixtureSkip, "QA_VNC_PASSWORD"):
                vnc_required.setup(context(Path(directory), cfg))

    def test_resets_the_fixture_and_exposes_per_case_files(self):
        fixture = FakeFixture()
        try:
            port, control = fixture.ports()
            with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"QA_VNC_PASSWORD": "Qvtest12"}):
                root = Path(directory)
                ctx = context(root, {"vnc": {"host": "127.0.0.1", "port": port, "control_port": control}})
                vnc_required.setup(ctx)
                events, commands = Path(ctx.values["vnc_events"]), Path(ctx.values["vnc_control"])
                self.assertEqual(ctx.values["vnc_port"], str(port))
                self.assertTrue(events.is_file() and commands.is_file())
                self.assertTrue(events.resolve().is_relative_to(root.resolve()))
                self.assertEqual(fixture.commands, ["reset", f"log {events}", f"watch {commands}"])
        finally:
            fixture.close()

    def test_a_misbehaving_control_port_is_an_error_not_a_skip(self):
        fixture = FakeFixture(reply="unknown command")
        try:
            port, control = fixture.ports()
            with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"QA_VNC_PASSWORD": "Qvtest12"}):
                ctx = context(Path(directory), {"vnc": {"host": "127.0.0.1", "port": port, "control_port": control}})
                with self.assertRaisesRegex(RuntimeError, "control port"):
                    vnc_required.setup(ctx)
        finally:
            fixture.close()

    def test_an_unreachable_fixture_skips(self):
        with socket.create_server(("127.0.0.1", 0)) as probe:
            closed = probe.getsockname()[1]
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"QA_VNC_PASSWORD": "Qvtest12"}):
            ctx = context(Path(directory), {"vnc": {"host": "127.0.0.1", "port": closed, "control_port": closed}})
            with self.assertRaisesRegex(FixtureSkip, "unreachable"):
                vnc_required.setup(ctx)


class ArdRequiredTest(unittest.TestCase):
    def test_skips_without_screen_sharing_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(FixtureSkip, "ard.host"):
                ard_required.setup(context(Path(directory), {"ard": {"host": "127.0.0.1", "port": 5900}}))

    def test_teardown_logs_the_hosted_account_out(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch("qa_ui_auto.fixtures.ard_required.subprocess.run") as run:
            hosted = {"ard": {"user": "qaard", "end_session": True}}
            with patch.dict("os.environ", {"GITHUB_ACTIONS": "true"}):
                ard_required.teardown(context(Path(directory), hosted))
                ard_required.teardown(context(Path(directory), {"ard": {"user": "me"}}))
            with patch.dict("os.environ", {"GITHUB_ACTIONS": ""}):
                ard_required.teardown(context(Path(directory), hosted))
            self.assertEqual([call.args[0] for call in run.call_args_list],
                             [["sudo", "-n", "pkill", "-KILL", "-u", "qaard"]])

    def test_fails_when_hosted_provisioning_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = context(Path(directory), {"ard": {"unavailable": "RuntimeError: readiness timed out"}})
            with self.assertRaises(RuntimeError) as raised:
                ard_required.setup(ctx)
            self.assertNotIsInstance(raised.exception, FixtureSkip)
            self.assertIn("readiness timed out", str(raised.exception))

    def test_exposes_the_account_when_screen_sharing_answers(self):
        server = socket.create_server(("127.0.0.1", 0))
        def answer():
            conn, _ = server.accept()
            with conn:
                conn.sendall(b"RFB 003.889\n")
        threading.Thread(target=answer, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"QA_ARD_PASSWORD": "Qa1-x"}):
                ctx = context(Path(directory), {"ard": {"host": "127.0.0.1", "port": server.getsockname()[1],
                                                        "user": " runner "}})
                ard_required.setup(ctx)
                self.assertEqual(ctx.values["ard_user"], "runner")
                self.assertEqual(ctx.values["ard_port"], str(server.getsockname()[1]))
        finally:
            server.close()


class BrowserHostFilesTest(unittest.TestCase):
    def test_host_file_verbs_stay_inside_the_report_root(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            ctx = StepContext(page=None, case_id="TC-vnc", case_dir=root / "TC-vnc", cfg={}, env={})
            target = root / "vnc-fixture" / "TC-vnc-control.txt"
            target.parent.mkdir()
            target.write_text("", encoding="utf-8")
            REGISTRY["host_write_file"](ctx, {"path": str(target), "text": "resize 1024 768\n"})
            self.assertEqual(target.read_text(encoding="utf-8"), "resize 1024 768\n")
            REGISTRY["assert_file_contains"](ctx, {"path": str(target), "contains": "resize", "timeout_sec": 1})
            with self.assertRaisesRegex(StepError, "does not contain"):
                REGISTRY["assert_file_contains"](ctx, {"path": str(target), "contains": "bell", "timeout_sec": 0.3})
            foreign = Path(outside) / "x.txt"
            foreign.write_text("resize", encoding="utf-8")
            with self.assertRaisesRegex(StepError, "report root"):
                REGISTRY["assert_file_contains"](ctx, {"path": str(foreign), "contains": "resize"})
            with self.assertRaisesRegex(StepError, "report root"):
                REGISTRY["host_write_file"](ctx, {"path": str(foreign), "text": "x"})


if __name__ == "__main__":
    unittest.main()
