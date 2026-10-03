"""Tests for runner-owned local SSH/MySQL service lifecycle."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.service_fixtures import LocalServiceFixtures  # noqa: E402


class LocalServiceFixtureTest(unittest.TestCase):
    def test_disabled_services_do_not_touch_docker(self):
        cfg = {"fixtures": {"start_local_sshd": False, "start_local_mysql": False}}
        with patch("qa_ui_auto.service_fixtures._docker_available") as docker:
            with LocalServiceFixtures(cfg, {}):
                pass
        docker.assert_not_called()

    def test_enabled_services_start_once_and_cleanup_in_reverse_order(self):
        cfg = {
            "ssh": {"host": "127.0.0.1", "port": 2222, "user": "testuser"},
            "database": {
                "host": "127.0.0.1",
                "port": 3306,
                "user": "test",
                "database": "test",
            },
            "fixtures": {
                "start_local_sshd": True,
                "sshd_port": 2222,
                "sshd_user": "testuser",
                "sshd_password": "${env.QA_SSH_PASSWORD}",
                "start_local_mysql": True,
                "mysql_port": 3306,
                "mysql_user": "test",
                "mysql_password": "${env.TAOMNI_TEST_MYSQL_PASSWORD}",
                "mysql_root_password": "${env.TAOMNI_TEST_MYSQL_ROOT_PASSWORD}",
                "mysql_database": "test",
            },
        }
        env = {
            "QA_SSH_PASSWORD": "ssh-test-only",
            "TAOMNI_TEST_MYSQL_PASSWORD": "mysql-test-only",
            "TAOMNI_TEST_MYSQL_ROOT_PASSWORD": "root-test-only",
        }
        with (
            patch("qa_ui_auto.service_fixtures._docker_available", return_value=True),
            patch("qa_ui_auto.service_fixtures.start_sshd", return_value="ssh"),
            patch("qa_ui_auto.service_fixtures.start_mysql", return_value="mysql"),
            patch("qa_ui_auto.service_fixtures.stop_container") as stop,
        ):
            with LocalServiceFixtures(cfg, env):
                self.assertEqual(cfg["ssh"]["port"], 2222)
                self.assertEqual(cfg["database"]["port"], 3306)
            self.assertEqual([call.args[0] for call in stop.call_args_list], ["mysql", "ssh"])

    def test_enabled_mysql_requires_root_password(self):
        cfg = {
            "fixtures": {
                "start_local_mysql": True,
                "mysql_user": "test",
                "mysql_password": "test-password",
                "mysql_database": "test",
            }
        }
        with (
            patch("qa_ui_auto.service_fixtures._docker_available", return_value=True),
            patch("qa_ui_auto.service_fixtures.start_mysql") as start,
        ):
            with self.assertRaisesRegex(Exception, "mysql_root_password"):
                with LocalServiceFixtures(cfg, {}):
                    pass
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()