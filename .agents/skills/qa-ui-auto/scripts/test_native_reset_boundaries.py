"""Reset every run-owned configuration namespace between native cases."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import tauri_webdriver as native
from native_build import QA_APP_ID
from qa_ui_auto.fixtures import reset_db


class NativeResetBoundariesTest(unittest.TestCase):
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
