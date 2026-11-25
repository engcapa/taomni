"""Pure contracts: subprocesses, mounts, native IPC and kernel policy are mocked."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from linux_noexec import NoExecBind
from qa_ui_auto.behavior_contract import is_check
from qa_ui_auto.fixtures.module_execution import setup, state
from qa_ui_auto.module_execution_observation import run, snapshot, validate
from qa_ui_auto.steps import StepError


class NoExecMountTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.owner = Path(self.temporary.name).resolve()
        self.target = self.owner / "installed"
        self.target.mkdir()
        self.mount = NoExecBind(self.target, self.owner)
        self.record = None
        self.blocked = False
        self.fail_remount = False
        self.calls = []
        self.addCleanup(patch.stopall)
        patch("linux_noexec.mount_record", side_effect=lambda _: self.record).start()
        patch("linux_noexec.is_noexec", side_effect=lambda _: self.blocked).start()
        patch("linux_noexec.subprocess.run", side_effect=self.command).start()

    def command(self, command, **kwargs):
        self.assertEqual(command[:2], ["sudo", "-n"])
        self.assertTrue(kwargs["check"])
        self.assertEqual(kwargs["timeout"], 20)
        self.calls.append(command)
        if command[2:4] == ["mount", "--bind"]:
            self.record = {"id": "47", "options": ["rw"], "raw": "mocked owned mount"}
        elif command[2:4] == ["mount", "-o"]:
            if self.fail_remount:
                raise subprocess.CalledProcessError(1, command)
            self.blocked = True
        elif command[2] == "umount":
            self.record, self.blocked = None, False
        else:
            self.fail(f"Unexpected privileged command {command!r}")
        return SimpleNamespace(returncode=0)

    def test_only_the_exact_owned_directory_is_bound_and_cleanup_restores_it(self):
        self.mount.block()
        self.assertEqual(self.mount.mount_id, "47")
        self.assertTrue(self.blocked)
        self.assertEqual(self.calls[0], ["sudo", "-n", "mount", "--bind", "--", str(self.target), str(self.target)])
        self.assertEqual(self.calls[1], ["sudo", "-n", "mount", "-o", "remount,bind,noexec,nosuid,nodev", "--", str(self.target)])
        self.mount.restore()
        self.mount.restore()
        self.assertEqual(self.calls[-1], ["sudo", "-n", "umount", "--", str(self.target)])
        self.assertEqual(len(self.calls), 3)
        self.assertIsNone(self.mount.mount_id)

    def test_remount_failure_cleans_up_the_successful_bind(self):
        self.fail_remount = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.mount.block()
        self.assertEqual(self.calls[-1][2], "umount")
        self.assertIsNone(self.mount.mount_id)
        self.assertFalse(self.blocked)

    def test_failure_to_observe_the_new_mount_still_removes_the_owned_bind(self):
        with patch("linux_noexec.mount_record", side_effect=[None, None]):
            with self.assertRaisesRegex(RuntimeError, "observable mount identity"):
                self.mount.block()
        self.assertEqual([command[2] for command in self.calls], ["mount", "umount"])
        self.assertIsNone(self.mount.mount_id)

    def test_interruption_during_remount_also_releases_the_owned_mount(self):
        original = self.mount.command
        def interrupt(*args):
            if args[:2] == ("mount", "-o"):
                raise KeyboardInterrupt()
            return original(*args)
        with patch.object(self.mount, "command", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.mount.block()
        self.assertEqual(self.calls[-1][2], "umount")
        self.assertIsNone(self.mount.mount_id)

    def test_existing_or_replaced_mounts_are_never_unmounted(self):
        self.record = {"id": "foreign"}
        with self.assertRaisesRegex(RuntimeError, "unmounted"):
            self.mount.block()
        self.assertEqual(self.calls, [])
        self.record = None
        self.mount.block()
        before = len(self.calls)
        self.record = {"id": "replaced"}
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            self.mount.restore()
        self.assertEqual(len(self.calls), before)

    def test_outside_root_root_itself_and_symlink_are_rejected_without_sudo(self):
        with tempfile.TemporaryDirectory() as outside:
            link = self.owner / "link"
            link.symlink_to(self.target, target_is_directory=True)
            for target in [Path(outside).resolve(), self.owner, link]:
                with self.assertRaisesRegex(RuntimeError, "owned run"):
                    NoExecBind(target, self.owner).block()
        self.assertEqual(self.calls, [])


class ExecutionObservationTests(unittest.TestCase):
    def test_actions_are_not_misreported_as_assertions_and_yaml_cannot_choose_paths(self):
        for phase in ["block", "restore", "rejected", "recovered"]:
            self.assertEqual(validate({"phase": phase}), phase)
            self.assertEqual(is_check({"module_execution_probe": {"phase": phase}}), phase in {"rejected", "recovered"})
        for args in [{"phase": "block", "path": "/tmp"}, {"phase": "run"}, "rejected"]:
            with self.assertRaises(StepError):
                validate(args)

    def test_native_step_context_uses_the_fixture_owner_and_local_execution_is_rejected(self):
        owner = SimpleNamespace(module_execution=NoExecBind(Path("/unused/child"), Path("/unused")))
        self.assertIs(state(SimpleNamespace(fixture_context=owner)), owner.module_execution)
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}):
            with self.assertRaisesRegex(StepError, "GitHub-hosted"):
                setup(SimpleNamespace(cfg={"app": {"mode": "native"}}))

    def observation(self, root):
        module = root / "plugins/hello-plugin"
        version = module / "versions/0.1.0"
        version.mkdir(parents=True)
        (version / "signed-host").write_bytes(b"unchanged signed bytes")
        (module / "data").mkdir()
        (module / "data/hello.sqlite").write_bytes(b"unchanged user data")
        (module / "active.json").write_text(json.dumps({"active_version": "0.1.0", "enabled": True}))
        mount = NoExecBind(version, root)
        mount.mount_id = "47"
        mount.original = snapshot(mount)
        return mount, SimpleNamespace(case_dir=root, session=Mock(), fixture_context=SimpleNamespace(module_execution=mount))

    def test_rejection_requires_the_stable_code_advice_and_unchanged_real_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            mount, ctx = self.observation(root)
            rejection = {"error": {"code": -32004, "message": f"MODULE_HOST_NOEXEC: noexec {mount.target}; XDG_DATA_HOME"}}
            with patch("qa_ui_auto.module_execution_observation.is_noexec", return_value=True), \
                    patch("qa_ui_auto.module_execution_observation.writer_lease", return_value={"held": False}), \
                    patch("qa_ui_auto.module_execution_observation.invoke", return_value=rejection):
                run(ctx, {"phase": "rejected"})
                self.assertEqual(snapshot(mount), mount.original)
                rejection["error"]["code"] = -32603
                with self.assertRaisesRegex(StepError, "code or recovery advice"):
                    run(ctx, {"phase": "rejected"})
                rejection["error"]["code"] = -32004
                (mount.target.parent.parent / "data/hello.sqlite").write_bytes(b"unexpected mutation")
                with self.assertRaisesRegex(StepError, "changed module code"):
                    run(ctx, {"phase": "rejected"})
            rows = [json.loads(line) for line in (root / "module-execution-observations.jsonl").read_text().splitlines()]
            self.assertEqual([row["passed"] for row in rows], [True, False, False])


if __name__ == "__main__":
    unittest.main()
