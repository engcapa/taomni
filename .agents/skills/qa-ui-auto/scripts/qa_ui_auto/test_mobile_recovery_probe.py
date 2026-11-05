"""Recovery assertions must preserve runner budgets with real Playwright locators."""
import unittest
from unittest.mock import Mock, patch

from .deadline import BudgetedPage, Deadline
from .mobile_recovery_probe import expect, fail_status_after_message, task_session_url


class RecoveryExpectTest(unittest.TestCase):
    def test_unwraps_locator_and_clamps_each_assertion_to_the_remaining_deadline(self):
        target = object()
        deadline = Deadline(2)
        locator = BudgetedPage(target, deadline)
        with patch('qa_ui_auto.mobile_recovery_probe.playwright_expect') as assertion:
            expect(locator, timeout=70000).to_be_visible()
        assertion.assert_called_once_with(target)
        timeout = assertion.return_value.to_be_visible.call_args.kwargs['timeout']
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 2000)

    def test_route_predicate_covers_encoded_detail_message_and_rejects_list(self):
        for suffix in ('thread%3At', 'thread%3At/message', 'thread%3At/stop'):
            self.assertTrue(task_session_url('http://127.0.0.1/api/v1/sessions/' + suffix))
        self.assertFalse(task_session_url('http://127.0.0.1/api/v1/sessions'))
        self.assertFalse(task_session_url('http://127.0.0.1/api/v1/tasks/thread%3At/changes'))

    def test_status_fault_waits_for_message_instead_of_racing_the_previous_stop_event(self):
        submitted = []
        def route(method, path):
            return Mock(request=Mock(method=method, url='http://127.0.0.1/api/v1/sessions/thread%3At' + path))
        late_stop = route('GET', '')
        fail_status_after_message(late_stop, submitted)
        late_stop.continue_.assert_called_once()
        late_stop.fulfill.assert_not_called()
        message = route('POST', '/message')
        fail_status_after_message(message, submitted)
        message.continue_.assert_called_once()
        self.assertEqual(submitted, [True])
        status = route('GET', '')
        fail_status_after_message(status, submitted)
        status.fulfill.assert_called_once_with(status=503, content_type='application/json', body='{"error":"connection_failed"}')
        status.continue_.assert_not_called()

    def test_preserves_raw_locator_and_requested_timeout(self):
        locator = Mock()
        with patch('qa_ui_auto.mobile_recovery_probe.playwright_expect') as assertion:
            expect(locator, timeout=1234).to_contain_text('retained output')
        assertion.assert_called_once_with(locator)
        assertion.return_value.to_contain_text.assert_called_once_with('retained output', timeout=1234)
