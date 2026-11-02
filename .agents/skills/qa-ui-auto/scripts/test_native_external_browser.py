"""Authorization browser ownership must never reach pre-existing/foreign processes."""
from pathlib import Path
import os
import signal
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

from native_external_browser import ExternalBrowserOwner, identity, inherits_isolation


class ExternalBrowserOwnerTest(TestCase):
    def layout(self, root):
        proc = root / "proc"
        proc.mkdir()
        expected = {f"XDG_{name}_HOME": str(root / name.lower())
                    for name in ("DATA", "CONFIG", "CACHE")}
        return proc, expected

    def process(self, proc, pid, expected, *, started="100", executable="firefox", state="S"):
        entry = proc / str(pid)
        entry.mkdir()
        binary = proc.parent / executable
        binary.touch(exist_ok=True)
        (entry / "exe").symlink_to(binary)
        fields = [state, "0", "50"] + ["0"] * 16 + [started]
        (entry / "stat").write_text(f"{pid} (browser name) " + " ".join(fields))
        (entry / "environ").write_bytes(b"\0".join(
            f"{key}={value}".encode() for key, value in expected.items()) + b"\0UNRELATED=not-retained\0")
        return entry

    def test_only_new_browser_with_all_three_run_roots_receives_a_signal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            self.process(proc, 1, expected)  # pre-existing, even in same isolation
            with patch.dict(os.environ, expected):
                owner = ExternalBrowserOwner(root, root, expected, proc)
            own = self.process(proc, 2, expected)
            self.process(proc, 3, {**expected, "XDG_DATA_HOME": str(root / "foreign")})
            self.process(proc, 4, expected, executable="unrelated-program")
            calls = []

            def terminate(pid, sig):
                calls.append((pid, sig))
                (own / "stat").unlink()

            with patch("native_external_browser.os.kill", side_effect=terminate):
                owner.stop()
            self.assertEqual(calls, [(2, signal.SIGTERM)])
            self.assertEqual(owner.record["status"], "closed")
            self.assertEqual([item["pid"] for item in owner.record["closed"]], [2])
            self.assertEqual([item["pid"] for item in owner.record["excluded"]], [3])
            self.assertNotIn("UNRELATED", owner.path.read_text())
            with patch("native_external_browser.os.kill") as kill:
                owner.stop()
                kill.assert_not_called()

    def test_missing_isolation_or_non_run_root_fails_before_process_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            for values in ({}, {**expected, "XDG_DATA_HOME": str(root.parent / "foreign")}):
                with self.subTest(values=values), patch.dict(os.environ, values), \
                        patch("native_external_browser.browsers") as observe:
                    with self.assertRaisesRegex(RuntimeError, "requires|refuses"):
                        ExternalBrowserOwner(root, root, values, proc)
                    observe.assert_not_called()
            with patch.dict(os.environ, expected), patch("native_external_browser.browsers") as observe:
                os.environ["XDG_CACHE_HOME"] = "different"
                with self.assertRaisesRegex(RuntimeError, "active native isolation"):
                    ExternalBrowserOwner(root, root, expected, proc)
                observe.assert_not_called()

    def test_pid_reuse_or_environment_change_before_signal_stays_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            with patch.dict(os.environ, expected):
                owner = ExternalBrowserOwner(root, root, expected, proc)
            self.process(proc, 10, expected)
            original = identity(10, proc)
            assert original is not None
            for changed in (None, {**original, "started": "new-birth"}):
                with self.subTest(changed=changed), \
                        patch.object(owner, "current_owned", return_value=[original]), \
                        patch("native_external_browser.identity", return_value=changed), \
                        patch("native_external_browser.os.kill") as kill:
                    with self.assertRaisesRegex(RuntimeError, "ownership changed"):
                        owner.stop()
                    kill.assert_not_called()
            with patch.object(owner, "current_owned", return_value=[original]), \
                    patch("native_external_browser.inherits_isolation", return_value=False), \
                    patch("native_external_browser.os.kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "ownership changed"):
                    owner.stop()
                kill.assert_not_called()

    def test_lingering_browser_never_passes_cleanup_or_receives_force_kill(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            with patch.dict(os.environ, expected):
                owner = ExternalBrowserOwner(root, root, expected, proc)
            self.process(proc, 11, expected)
            with patch("native_external_browser.os.kill") as kill, \
                    patch("native_external_browser.time.monotonic", side_effect=[0, 1]):
                with self.assertRaisesRegex(RuntimeError, "did not exit"):
                    owner.stop(timeout=0.5)
                kill.assert_called_once_with(11, signal.SIGTERM)
            self.assertEqual(owner.record["status"], "failed")

    def test_private_profile_proves_chrome_ownership_even_when_xdg_is_not_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            profile = Path(expected["XDG_CACHE_HOME"]) / "auth-private"
            profile.mkdir(parents=True)
            (profile / ".taomni-qa-browser").write_text("fixture")
            with patch.dict(os.environ, expected):
                owner = ExternalBrowserOwner(root, root, expected, proc, profile=profile)
            owned = self.process(proc, 30, {}, executable="chrome")
            (owned / "cmdline").write_bytes(b"chrome\0--user-data-dir=" + str(profile).encode() + b"\0")
            other = self.process(proc, 31, expected, executable="chrome")
            (other / "cmdline").write_bytes(b"chrome\0--user-data-dir=/foreign\0")
            with patch("native_external_browser.os.kill", side_effect=lambda pid, sig: (proc / str(pid) / "stat").unlink()) as kill:
                owner.stop()
                kill.assert_called_once_with(30, signal.SIGTERM)
            self.assertEqual(owner.record["status"], "closed")
            self.assertEqual([item["pid"] for item in owner.record["excluded"]], [31])

    def test_private_profile_does_not_match_a_url_or_prefix_and_must_be_run_owned(self):
        from native_external_browser import owns_profile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            profile = Path(expected["XDG_CACHE_HOME"]) / "auth"
            for args, owned in ((["firefox", "--profile", str(profile)], True),
                                (["chrome", "--user-data-dir=" + str(profile)], True),
                                (["chrome", "--user-data-dir=" + str(profile) + "-other"], False),
                                (["firefox", "https://example.org/" + str(profile)], False)):
                process = self.process(proc, 40, expected)
                (process / "cmdline").write_bytes(b"\0".join(arg.encode() for arg in args))
                self.assertEqual(owns_profile(40, profile, proc), owned)
                for path in process.iterdir():
                    path.unlink()
                process.rmdir()
            with patch.dict(os.environ, expected):
                with self.assertRaisesRegex(RuntimeError, "run-owned cache"):
                    ExternalBrowserOwner(root, root, expected, proc, profile=root / "unowned")

    def test_no_owned_browser_is_not_a_cleanup_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            with patch.dict(os.environ, expected):
                owner = ExternalBrowserOwner(root, root, expected, proc)
            with patch("native_external_browser.os.kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "no independently identifiable"):
                    owner.stop()
                kill.assert_not_called()

    def test_dead_malformed_and_inaccessible_processes_do_not_establish_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, expected = self.layout(root)
            self.process(proc, 20, expected, state="Z")
            bad = self.process(proc, 21, expected)
            (bad / "stat").write_text("malformed")
            self.assertIsNone(identity(20, proc))
            self.assertIsNone(identity(21, proc))
            self.assertIsNone(identity(22, proc))
            self.assertFalse(inherits_isolation(22, expected, proc))


if __name__ == "__main__":
    main()
