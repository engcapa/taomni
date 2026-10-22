"""A readiness probe must not activate a competing locked Secret Service."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto.fixtures import credential_store
from tauri_webdriver import native_isolation_env


class CredentialServiceOwnerTest(unittest.TestCase):
    def test_waits_without_activation_before_the_first_credential_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, report_root=root)
            environment = {**native_isolation_env(root), "GITHUB_ACTIONS": "true",
                           "DBUS_SESSION_BUS_ADDRESS": "private-test-bus"}
            state = {"owner_queries": 0, "owned": False, "activated_locked": False, "now": 0.0}
            operations = []

            def execute(command, **kwargs):
                if command[0] == "gdbus":
                    self.assertEqual(command[-2:], ["org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"])
                    state["owner_queries"] += 1
                    state["owned"] = state["owner_queries"] >= 3
                    return SimpleNamespace(stdout="(true,)" if state["owned"] else "(false,)")
                if command[0] == "secret-tool":
                    operations.append(command[1])
                    if not state["owned"] or state["activated_locked"]:
                        state["activated_locked"] = True
                        state["now"] = 5.0
                        raise subprocess.CalledProcessError(1, command, stderr="Cannot create an item in a locked collection")
                    return SimpleNamespace(stdout="probe-secret\n" if command[1] == "lookup" else "")
                return SimpleNamespace(stdout="", stderr="")

            with patch.dict(os.environ, environment, clear=True), \
                 patch.object(credential_store.platform, "system", return_value="Linux"), \
                 patch.object(credential_store.secrets, "token_hex", return_value="probe-secret"), \
                 patch.object(credential_store.time, "monotonic", side_effect=lambda: state["now"]), \
                 patch.object(credential_store.time, "sleep"), \
                 patch.object(credential_store.subprocess, "run", side_effect=execute):
                credential_store.setup(ctx)
            self.assertFalse(state["activated_locked"])
            self.assertEqual(operations, ["store", "lookup", "clear"])
            text = next(root.glob("credential-store-readiness/*.json")).read_text()
            self.assertNotIn("probe-secret", text)
            trace = json.loads(text)
            self.assertEqual(trace["service_owner_checks"], [False, False, True])
            self.assertEqual(trace["status"], "ready")

    def test_missing_owner_fails_at_the_existing_deadline_without_starting_a_store(self):
        now = [0.0]
        trace = {}
        commands = []

        def execute(command, **kwargs):
            commands.append(command)
            self.assertLessEqual(kwargs["timeout"], 1 - now[0])
            now[0] += 0.4
            return SimpleNamespace(stdout="(false,)")

        with patch.object(credential_store.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(credential_store.time, "sleep"), \
             patch.object(credential_store.subprocess, "run", side_effect=execute):
            with self.assertRaisesRegex(TimeoutError, "bus name"):
                credential_store._wait_for_service(trace, 1)
        self.assertEqual(len(commands), 3)
        self.assertTrue(all(command[0] == "gdbus" for command in commands))

    def test_bus_failure_is_fatal_instead_of_activating_a_fallback_service(self):
        failure = subprocess.CalledProcessError(1, ["gdbus"], stderr="private bus closed")
        with patch.object(credential_store.subprocess, "run", side_effect=failure) as run:
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                credential_store._wait_for_service({}, credential_store.time.monotonic() + 5)
        self.assertIs(caught.exception, failure)
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
