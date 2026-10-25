"""Reset every run-owned configuration namespace between native cases."""
import os
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import tauri_webdriver as native
from native_build import QA_APP_ID
from qa_ui_auto.fixtures import reset_db


class NativeResetBoundariesTest(unittest.TestCase):
    def test_renderer_reset_removes_workspace_and_ide_state_but_retains_unrelated_keys(self):
        session = Mock()
        session.execute.side_effect = [True, True]
        with patch.object(reset_db, "_native_profile_targets") as boundary:
            reset_db.reset_native_renderer(SimpleNamespace(), session)
        boundary.assert_called_once()
        reset_script = session.execute.call_args_list[0].args[0]
        keys = json.loads(reset_script.split("const keys = ")[1].split(";")[0])
        prefixes = json.loads(reset_script.split("const prefixes = ")[1].split(";")[0])
        previous_case = {
            "taomni.platformWorkspaces.v1": "previous host files and sessions",
            "taomni.workspaceDocuments.recovery.v1": "previous unsaved draft",
            "taomni.mergeToolWindowRail": "false",
            "taomni.sidebarCollapsedByGroup.v1": "previous navigation",
            "taomni.quickConnectVisible": "true",
            "taomni.codeWorkspace.toolWindowStripes.v1": "previous stripe placement",
            "taomni.codeWorkspace.lspJavaSettings.v1": "previous language settings",
            "taomni.recentWorkspaces.v1": "previous project",
            "taomni.newFeature.preference": "previous unknown preference",
            "unrelated.website.preference": "preserved",
        }
        retained = {key: value for key, value in previous_case.items()
                    if key not in keys and not any(key.startswith(prefix) for prefix in prefixes)}
        self.assertEqual(retained, {"unrelated.website.preference": "preserved"})
        self.assertIn("window.location.reload()", reset_script)
        self.assertIn("__QA_UI_AUTO_RESET_PENDING__ !== true", session.execute.call_args_list[1].args[0])
        session.install_console_hook.assert_called_once()

    def test_renderer_reset_restores_current_case_jdk_after_removing_previous_jdk(self):
        session = Mock()
        session.execute.side_effect = [True, True]
        with patch.object(reset_db, "_native_profile_targets"):
            reset_db.reset_native_renderer(SimpleNamespace(), session, tooling_java_home="/qa/current-jdk-25")
        script = session.execute.call_args_list[0].args[0]
        jdk = json.loads(script.split("const toolingJavaHome = ")[1].split(";")[0])
        self.assertEqual(jdk, "/qa/current-jdk-25")
        self.assertLess(script.index("localStorage.removeItem(key)"), script.index("localStorage.setItem("))
        self.assertLess(script.index("localStorage.setItem("), script.index("window.location.reload()"))
        self.assertIn("'taomni.codeWorkspace.lspJavaHome.v1', toolingJavaHome", script)

    def test_case_renderer_resets_only_macos_cases_that_declare_reset_db(self):
        with patch.object(reset_db.platform, "system", return_value="Linux"), \
                patch.object(reset_db, "reset_native_renderer") as reset:
            self.assertIsNone(reset_db.reset_case_renderer(None, None, ["reset_db"], "/jdk21"))
            reset.assert_not_called()
        with patch.object(reset_db.platform, "system", return_value="Darwin"), \
                patch.object(reset_db, "reset_native_renderer") as reset:
            self.assertIsNone(reset_db.reset_case_renderer(None, None, [], "/jdk21"))
            self.assertGreaterEqual(reset_db.reset_case_renderer(None, None, ["reset_db"], "/jdk25"), 0)
            reset.assert_called_once_with(None, None, tooling_java_home="/jdk25")

    def test_linux_reset_removes_closed_proxy_and_ai_config_before_next_case(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(native.platform, "system", return_value="Linux"):
            root = Path(directory)
            run = root / "run"
            env = native.native_isolation_env(run)
            config = Path(env["XDG_CONFIG_HOME"]) / "taomni"
            config.mkdir(parents=True)
            (config / "proxy.json").write_text('{"enabled":true,"host":"127.0.0.1","port":1}')
            (config / "ai.json").write_text('{"fully_disabled":true}')
            profile = Path(env["XDG_DATA_HOME"]) / QA_APP_ID
            profile.mkdir(parents=True)
            (profile / "taomni.db").touch()
            cache = Path(env["XDG_CACHE_HOME"]) / "taomni"
            cache.mkdir(parents=True)
            (cache / "perf-baseline.jsonl").touch()
            unrelated = Path(env["XDG_CONFIG_HOME"]) / "desktop-settings"
            unrelated.mkdir()
            personal = root / "personal" / "taomni"
            personal.mkdir(parents=True)
            (personal / "proxy.json").write_text("personal proxy")

            with patch.dict(os.environ, env):
                reset_db._reset_native(SimpleNamespace(report_root=run))

            self.assertFalse(profile.exists())
            self.assertFalse(config.exists(), "a stopped fixture proxy must not affect the next case")
            self.assertFalse(cache.exists())
            self.assertTrue(unrelated.is_dir())
            self.assertEqual((personal / "proxy.json").read_text(), "personal proxy")

    def test_symlinked_config_refuses_reset_before_deleting_any_profile(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(native.platform, "system", return_value="Linux"):
            root = Path(directory)
            run = root / "run"
            env = native.native_isolation_env(run)
            config_home = Path(env["XDG_CONFIG_HOME"])
            config_home.mkdir(parents=True)
            personal = root / "personal"
            personal.mkdir()
            (personal / "proxy.json").write_text("personal proxy")
            (config_home / "taomni").symlink_to(personal, target_is_directory=True)
            profile = Path(env["XDG_DATA_HOME"]) / QA_APP_ID
            profile.mkdir(parents=True)
            (profile / "taomni.db").touch()

            with patch.dict(os.environ, env):
                with self.assertRaisesRegex(RuntimeError, "symlinked QA profile"):
                    reset_db._reset_native(SimpleNamespace(report_root=run))

            self.assertTrue((profile / "taomni.db").exists())
            self.assertEqual((personal / "proxy.json").read_text(), "personal proxy")


if __name__ == "__main__":
    unittest.main()
