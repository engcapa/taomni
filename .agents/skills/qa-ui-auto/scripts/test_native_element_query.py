"""Read-only stale queries may repeat; delivered clicks must never repeat."""
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import CaseTimeout, Deadline
from tauri_webdriver import NativeSession


STALE = 'HTTP 404: {"value":{"error":"stale element reference","message":"Stale element found when trying to create the node handle"}}'


class NativeElementQueryTests(unittest.TestCase):
    def session(self, responses):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=responses)
        return session

    def test_stale_count_requeries_css_for_an_empty_or_nonempty_result(self):
        for nodes in ([], [{"element-6066-11e4-a52e-4f735466cecf": "node-1"}]):
            with self.subTest(nodes=nodes), patch("native_element_query.budget_time.sleep") as sleep:
                session = self.session([WebDriverError(STALE), nodes])
                self.assertEqual(session.count('[data-testid="mobile-settings-revoke"]'), len(nodes))
                expected = call("POST", "/session/session-1/elements", {
                    "using": "css selector", "value": '[data-testid="mobile-settings-revoke"]'})
                self.assertEqual(session.request.call_args_list, [expected, expected])
                sleep.assert_called_once_with(0.1)

    def test_stale_count_preserves_xpath_selector_strategy(self):
        with patch("native_element_query.budget_time.sleep"):
            session = self.session([WebDriverError(STALE), []])
            self.assertEqual(session.count("xpath=//button"), 0)
        self.assertEqual(session.request.call_args.args[2], {"using": "xpath", "value": "//button"})

    def test_persistent_stale_count_stops_after_three_reads(self):
        session = self.session([WebDriverError(STALE) for _ in range(3)])
        with patch("native_element_query.budget_time.sleep") as sleep:
            with self.assertRaisesRegex(WebDriverError, "stale element reference"):
                session.count(".row")
        self.assertEqual(session.request.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_non_stale_errors_and_invalid_lists_never_become_zero(self):
        for response in (WebDriverError("HTTP 404: invalid session id"),
                         WebDriverError("HTTP 500: javascript error"),
                         TimeoutError("ambiguous transport failure"),
                         {"error": "bad response"}, None):
            with self.subTest(response=response), patch("native_element_query.budget_time.sleep") as sleep:
                session = self.session([response])
                with self.assertRaises((WebDriverError, TimeoutError)):
                    session.count(".row")
                self.assertEqual(session.request.call_count, 1)
                sleep.assert_not_called()

    def test_count_checks_case_deadline_before_each_read(self):
        session = self.session([WebDriverError(STALE), []])
        session.deadline = Mock()
        session.deadline.remaining.side_effect = [1.0, CaseTimeout("case execution deadline exceeded")]
        with patch("native_element_query.budget_time.sleep"):
            with self.assertRaises(CaseTimeout):
                session.count(".row")
        self.assertEqual(session.request.call_count, 1)
        expired = self.session([[]])
        expired.deadline = Deadline(-1)
        with self.assertRaises(CaseTimeout):
            expired.count(".row")
        expired.request.assert_not_called()

    def test_cleanup_retries_only_read_after_one_delivered_revoke(self):
        # Model the settings loop used by TC-MOBILE-008: a delivered removal
        # replaces its row while WebKit serializes the following element list.
        session = self.session([[{"element-6066-11e4-a52e-4f735466cecf": "device"}],
                                WebDriverError(STALE), []])
        session.click = Mock()
        with patch("native_element_query.budget_time.sleep"):
            while session.count('[data-testid="mobile-settings-revoke"]'):
                session.click('[data-testid="mobile-settings-revoke"]')
        session.click.assert_called_once_with('[data-testid="mobile-settings-revoke"]')
        self.assertTrue(all(c.args[1].endswith("/elements") for c in session.request.call_args_list))


if __name__ == "__main__":
    unittest.main()
