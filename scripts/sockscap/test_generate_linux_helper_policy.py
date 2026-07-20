#!/usr/bin/env python3
"""Focused tests for Linux helper policy release staging."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import runpy
import stat
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree


SCRIPT = runpy.run_path(
    str(Path(__file__).with_name("generate-linux-helper-policy.py"))
)
LinuxPolicyError = SCRIPT["LinuxPolicyError"]
build_policy = SCRIPT["build_policy"]
sha256_stable_regular_file = SCRIPT["sha256_stable_regular_file"]
write_policy_atomic = SCRIPT["write_policy_atomic"]
ROOT = Path(__file__).resolve().parents[2]
POLKIT_ACTION = (
    ROOT
    / "src-tauri"
    / "platform"
    / "sockscap"
    / "linux"
    / "com.taomni.sockscap.policy"
)


class LinuxHelperPolicyTests(unittest.TestCase):
    def test_policy_pins_final_application_helper_and_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            application = root / "taomni"
            helper = root / "sockscap-helper"
            runtime = root / "sockscap-runtime"
            application.write_bytes(b"application-final")
            helper.write_bytes(b"helper-final")
            runtime.write_bytes(b"runtime-final")

            policy = build_policy(application, helper, [runtime, runtime])

            self.assertEqual(policy["schemaVersion"], 1)
            self.assertEqual(policy["productId"], "com.taomni.app")
            self.assertEqual(
                policy["allowedCallerSha256"],
                [hashlib.sha256(b"application-final").hexdigest()],
            )
            self.assertEqual(
                policy["allowedHelperSha256"],
                [hashlib.sha256(b"helper-final").hexdigest()],
            )
            self.assertEqual(
                policy["allowedRuntimeSha256"],
                [hashlib.sha256(b"runtime-final").hexdigest()],
            )

    def test_runtime_defaults_to_application_and_output_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            application = root / "taomni"
            helper = root / "sockscap-helper"
            output = root / "policy.json"
            application.write_bytes(b"application")
            helper.write_bytes(b"helper")
            policy = build_policy(application, helper)

            write_policy_atomic(output, policy)
            first = output.read_bytes()
            write_policy_atomic(output, policy)
            second = output.read_bytes()

            self.assertEqual(first, second)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o644)
            decoded = json.loads(first)
            self.assertEqual(
                decoded["allowedRuntimeSha256"], decoded["allowedCallerSha256"]
            )

    def test_symlink_and_empty_binary_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_bytes(b"target")
            symlink = root / "link"
            symlink.symlink_to(target)
            empty = root / "empty"
            empty.touch()

            with self.assertRaises(LinuxPolicyError):
                sha256_stable_regular_file(symlink)
            with self.assertRaises(LinuxPolicyError):
                sha256_stable_regular_file(empty)

    def test_non_regular_output_is_rejected_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("keep", encoding="utf-8")
            output = root / "policy.json"
            output.symlink_to(target)

            with self.assertRaises(LinuxPolicyError):
                write_policy_atomic(output, {"schemaVersion": 1})
            self.assertEqual(target.read_text(encoding="utf-8"), "keep")

    def test_polkit_action_is_fixed_path_and_never_retains_authorization(self) -> None:
        root = ElementTree.parse(POLKIT_ACTION).getroot()
        action = root.find("action")
        self.assertIsNotNone(action)
        assert action is not None
        self.assertEqual(action.attrib["id"], "com.taomni.sockscap.helper")
        defaults = action.find("defaults")
        self.assertIsNotNone(defaults)
        assert defaults is not None
        self.assertEqual(defaults.findtext("allow_any"), "no")
        self.assertEqual(defaults.findtext("allow_inactive"), "no")
        self.assertEqual(defaults.findtext("allow_active"), "auth_admin")
        annotations = {
            node.attrib["key"]: node.text for node in action.findall("annotate")
        }
        self.assertEqual(
            annotations,
            {
                "org.freedesktop.policykit.exec.path": (
                    "/usr/libexec/taomni/sockscap-helper"
                )
            },
        )


if __name__ == "__main__":
    unittest.main()
