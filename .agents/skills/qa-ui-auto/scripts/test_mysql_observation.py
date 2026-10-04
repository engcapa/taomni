import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import MagicMock, patch

from qa_ui_auto.mysql_observation import assert_rows
from qa_ui_auto.steps import StepError


class MySQLObservationTest(TestCase):
    def config(self):
        return {"database": {"host": "127.0.0.1", "port": 3306, "user": "test",
                             "password": "${env.QA_OBSERVER_PASSWORD}", "database": "fixture"}}

    def driver(self, rows=((1,),)):
        driver = MagicMock()
        cursor = driver.connect.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = rows
        return driver, cursor

    def test_observer_resolves_environment_and_reads_through_an_independent_readonly_connection(self):
        driver, cursor = self.driver()
        with TemporaryDirectory() as directory, patch.dict("sys.modules", {"pymysql": driver}), \
                patch.dict("os.environ", {"QA_OBSERVER_PASSWORD": "disposable-secret"}):
            root = Path(directory)
            assert_rows(self.config(), {"query": "SELECT COUNT(*) FROM fixture;", "equals": [[1]]}, root)
            driver.connect.assert_called_once_with(host="127.0.0.1", port=3306, user="test",
                password="disposable-secret", database="fixture", autocommit=False,
                connect_timeout=5, read_timeout=10, write_timeout=5)
            self.assertEqual([call.args[0] for call in cursor.execute.call_args_list],
                             ["SET TRANSACTION READ ONLY", "SELECT COUNT(*) FROM fixture"])
            evidence = (root / "mysql-committed-rows.jsonl").read_text(encoding="utf-8")
            self.assertTrue(json.loads(evidence)["passed"])
            self.assertNotIn("disposable-secret", evidence)
        driver.connect.return_value.rollback.assert_called_once_with()
        driver.connect.return_value.close.assert_called_once_with()

    def test_missing_password_environment_fails_before_opening_connection(self):
        driver, _ = self.driver()
        with TemporaryDirectory() as directory, patch.dict("sys.modules", {"pymysql": driver}), \
                patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(KeyError, "QA_OBSERVER_PASSWORD"):
                assert_rows(self.config(), {"query": "SELECT 1", "equals": [[1]]}, Path(directory))
        driver.connect.assert_not_called()

    def test_mismatch_preserves_failed_observation_and_cleans_up(self):
        driver, _ = self.driver(((0,),))
        with TemporaryDirectory() as directory, patch.dict("sys.modules", {"pymysql": driver}), \
                patch.dict("os.environ", {"QA_OBSERVER_PASSWORD": "secret"}):
            with self.assertRaisesRegex(StepError, "differ"):
                assert_rows(self.config(), {"query": "SELECT 1", "equals": [[1]]}, Path(directory))
            evidence = (Path(directory) / "mysql-committed-rows.jsonl").read_text(encoding="utf-8")
            self.assertFalse(json.loads(evidence)["passed"])
        driver.connect.return_value.rollback.assert_called_once_with()
        driver.connect.return_value.close.assert_called_once_with()

    def test_query_failure_and_rollback_failure_still_close_the_connection(self):
        driver, cursor = self.driver()
        cursor.execute.side_effect = RuntimeError("query failed")
        driver.connect.return_value.rollback.side_effect = RuntimeError("rollback failed")
        with TemporaryDirectory() as directory, patch.dict("sys.modules", {"pymysql": driver}), \
                patch.dict("os.environ", {"QA_OBSERVER_PASSWORD": "secret"}):
            with self.assertRaisesRegex(RuntimeError, "rollback failed"):
                assert_rows(self.config(), {"query": "SELECT 1", "equals": [[1]]}, Path(directory))
        driver.connect.return_value.close.assert_called_once_with()

    def test_writes_and_multiple_statements_are_rejected_before_connecting(self):
        driver, _ = self.driver()
        with TemporaryDirectory() as directory, patch.dict("sys.modules", {"pymysql": driver}):
            for query in ("UPDATE fixture SET n=1", "SELECT 1; SELECT 2", "SELECT * FROM fixture FOR UPDATE"):
                with self.subTest(query=query), self.assertRaisesRegex(StepError, "read-only SELECT"):
                    assert_rows(self.config(), {"query": query, "equals": [[1]]}, Path(directory))
        driver.connect.assert_not_called()
