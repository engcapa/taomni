"""Verify that the installed GUI contender inherits its runner desktop."""

from contextlib import nullcontext
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import installed_mfa_upgrade as upgrade
from qa_ui_auto.legacy_process import MODE_LEASE_DENIAL


class InstalledMfaModeLeaseTests(unittest.TestCase):
    def test_gui_contender_inherits_x11_and_isolated_profile(self):
        work = Path("/qa/work")
        evidence = work / "evidence"
        binary = Path("/usr/bin/taomni")
        profile = work / "desktop/data/com.taomni.app"
        isolated = {"XDG_DATA_HOME": str(profile.parent)}
        desktop_env = {
            "DISPLAY": ":99",
            "XAUTHORITY": "/qa/Xauthority",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/qa/bus",
        }
        owner = SimpleNamespace(poll=lambda: None)
        driver = SimpleNamespace(proc=owner)

        def initialize(executable, data, _work, _evidence, _label, *, observe_ready):
            self.assertEqual((executable, data), (binary, profile))
            observe_ready(owner)
            return {"ready": True}

        with (
            patch.dict(os.environ, desktop_env, clear=True),
            patch.object(upgrade, "desktop_environment", return_value=(isolated, profile)),
            patch.object(upgrade, "installed_desktop", return_value=nullcontext((driver, object()))),
            patch.object(upgrade, "open_unlocked_mfa"),
            patch.object(upgrade, "desktop_action"),
            patch.object(upgrade, "close_verified_desktop", return_value={"closed": True}),
            patch.object(upgrade, "observe_same_profile_contender", return_value=MODE_LEASE_DENIAL) as observe,
            patch.object(upgrade, "initialize_profile", side_effect=initialize),
            patch.object(upgrade, "inspect_accounts", return_value={"hotp": "359 152"}),
        ):
            observation = {}
            upgrade.verify_desktop_profile_lease(object(), binary, work, profile, evidence, observation)
            self.assertEqual(os.environ, desktop_env)

        headless, desktop = observe.call_args_list
        self.assertEqual(
            headless.args[0],
            [str(binary), "--headless", "--data-dir", str(profile), "--mobile-port", "0"],
        )
        self.assertEqual(desktop.args[0], [str(binary)])
        self.assertEqual(desktop.kwargs["desktop_env"], {**desktop_env, **isolated})
        self.assertTrue(observation["passed"])
