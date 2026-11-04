"""Recovery assertions must preserve runner budgets with real Playwright locators."""
import unittest
from unittest.mock import Mock, patch

from .deadline import BudgetedPage, Deadline
from .mobile_recovery_probe import expect


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

    def test_preserves_raw_locator_and_requested_timeout(self):
        locator = Mock()
        with patch('qa_ui_auto.mobile_recovery_probe.playwright_expect') as assertion:
            expect(locator, timeout=1234).to_contain_text('retained output')
        assertion.assert_called_once_with(locator)
        assertion.return_value.to_contain_text.assert_called_once_with('retained output', timeout=1234)
