"""Exercise process identity and signal selection using inert fixtures."""
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from installed_mfa_crash import Process, abrupt_exit, identify, watch_process


class InstalledMfaCrashTests(unittest.TestCase):
    def test_identifies_owned_group_and_exact_host_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            core, module = root / "taomni", root / "mfa"
            core.touch()
            module.touch()
            for pid, parent, group, image, state in [
                (11, 10, 10, core, "S"), (12, 11, 12, module, "S"),
                (13, 11, 13, module, "Z"), (20, 19, 19, core, "S"),
                (21, 20, 21, module, "S"),
            ]:
                process = root / str(pid)
                process.mkdir()
                fields = [state, str(parent), str(group), *["0"] * 16, f"{pid}100"]
                (process / "stat").write_text(f"{pid} (synthetic name) " + " ".join(fields))
                (process / "exe").symlink_to(image)
            owner, host = identify(core, module, 10, root)
            self.assertEqual((owner.pid, host.pid), (11, 12))
            self.assertEqual(host.start_time, "12100")
            with self.assertRaisesRegex(RuntimeError, "owned driver group"):
                identify(core, module, 22, root)
            (root / "12/exe").unlink()
            with self.assertRaisesRegex(RuntimeError, "signed MFA host"):
                identify(core, module, 10, root)

    def test_identity_change_after_open_prevents_signaling_reused_pid(self):
        core = Process(11, 10, 10, "11100", "/owned/app")
        with patch("installed_mfa_crash.os.pidfd_open", return_value=99, create=True), \
                patch("installed_mfa_crash.os.close") as close, \
                patch("installed_mfa_crash.read_process", return_value=None), \
                self.assertRaisesRegex(RuntimeError, "identity changed"), ExitStack() as resources:
            watch_process(core, Path("/proc"), resources)
        close.assert_called_once_with(99)

    def test_only_sends_signal_to_core_and_requires_host_exit_before_returning(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            app, module = root / "app", root / "mfa"
            app.touch()
            module.touch()
            core = Process(11, 10, 10, "11100", str(app))
            host = Process(12, 11, 12, "12100", str(module))
            with patch("installed_mfa_crash.identify", return_value=(core, host)), \
                    patch("installed_mfa_crash.watch_process", side_effect=[9, 10]), \
                    patch("installed_mfa_crash.signal.pidfd_send_signal", create=True) as send, \
                    patch("installed_mfa_crash.wait_for_exit", side_effect=[None, RuntimeError("host survived")]) as wait:
                evidence = {}
                with self.assertRaisesRegex(RuntimeError, "host survived"):
                    abrupt_exit(app, module, 10, evidence)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0], 9)
        self.assertEqual([item.args[0] for item in wait.call_args_list], [9, 10])
        self.assertTrue(evidence["coreExited"])
        self.assertNotIn("hostExitedBeforeDriverCleanup", evidence)
