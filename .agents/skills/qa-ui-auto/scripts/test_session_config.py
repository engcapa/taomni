"""Unit contracts for isolated session inputs used by the hosted native cases."""
import json
import os
import socket
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tauri_webdriver import native_isolation_env
from qa_ui_auto.fixtures import session_config
from qa_ui_auto.fixtures.backup_policy import isolated_data_root


class SessionConfigFixtureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ctx = SimpleNamespace(report_root=self.root, cfg={"app": {"mode": "native"}}, values={})
        self.env = patch.dict(os.environ, native_isolation_env(self.root))
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_previous_scp_rows_retain_protocol_authentication_and_endpoint(self):
        config = {"host": "127.0.0.1", "port": 2222, "throttled_port": 2223,
                  "user": "qa", "key_path": "/run-owned/key"}
        for suffix, mode, port in [("001", "scp", 2222), ("002", "scp-fast", 2222), ("003", "scp", 2223)]:
            with self.subTest(case=suffix):
                self.ctx.case_id = "TC-SESSION-SCP-" + suffix
                data = isolated_data_root(self.ctx)
                database = data / "taomni.db"
                database.unlink(missing_ok=True)
                session_config.seed_legacy_scp(self.ctx, config)
                with sqlite3.connect(database) as db:
                    row = db.execute("SELECT host, port, username, auth_method, options_json FROM sessions").fetchone()
                self.assertEqual(row[:3], ("127.0.0.1", port, "qa"))
                self.assertEqual(json.loads(row[3]), {"PrivateKey": {"key_path": "/run-owned/key"}})
                self.assertEqual(json.loads(row[4]), {"sshBrowser": mode, "networkSettings": {"proxyKind": "none"}})

    def test_proxy_is_enabled_but_cannot_accept_connections_and_teardown_releases_port(self):
        self.addCleanup(session_config.teardown_unreachable_proxy, self.ctx)
        session_config.setup_unreachable_proxy(self.ctx)
        path = Path(self.ctx.values["unreachable_proxy_path"])
        self.assertTrue(path.is_relative_to(self.root))
        proxy = json.loads(path.read_text())
        self.assertTrue(proxy["enabled"])
        self.assertEqual(proxy["kind"], "http")
        with self.assertRaises(OSError):
            socket.create_connection((proxy["host"], proxy["port"]), timeout=1)
        session_config.teardown_unreachable_proxy(self.ctx)
        self.assertIsNone(self.ctx._session_proxy_socket)
        self.assertFalse(path.exists())
        # Fixture interpolation/report values remain JSON serializable.
        json.dumps(self.ctx.values)

    def test_proxy_teardown_restores_preexisting_qa_settings(self):
        expected = native_isolation_env(self.root)
        config = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
        path = config / "taomni" / "proxy.json"
        path.parent.mkdir(parents=True)
        original = b'{"enabled":false}\n'
        path.write_bytes(original)
        self.addCleanup(session_config.teardown_unreachable_proxy, self.ctx)
        session_config.setup_unreachable_proxy(self.ctx)
        self.assertNotEqual(path.read_bytes(), original)
        session_config.teardown_unreachable_proxy(self.ctx)
        self.assertEqual(path.read_bytes(), original)

    def test_setup_refuses_a_profile_without_the_matching_isolation_environment(self):
        self.ctx.report_root = self.root / "different-run"
        with self.assertRaisesRegex(RuntimeError, "isolation environment"):
            session_config.setup_unreachable_proxy(self.ctx)
        self.assertFalse(self.ctx.report_root.exists())


if __name__ == "__main__":
    unittest.main()
