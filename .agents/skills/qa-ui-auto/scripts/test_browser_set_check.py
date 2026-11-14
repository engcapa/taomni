"""Browser checkbox actions must enforce real input and its checked postcondition."""
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.steps.app_specific import step_set_check


class BrowserSetCheckContracts(TestCase):
    def test_uses_stable_checked_action_without_forced_click_or_unverified_toggle(self):
        for checked in (False, True):
            with self.subTest(checked=checked):
                locator = Mock(spec=["set_checked"])
                page = Mock()
                page.locator.return_value.first = locator
                step_set_check(SimpleNamespace(page=page, dry_run=False), {"selector": "#scripts", "checked": checked})
                page.locator.assert_called_once_with("#scripts")
                locator.set_checked.assert_called_once_with(checked)

    def test_action_failure_is_not_reported_as_a_success_or_retried(self):
        locator = Mock(spec=["set_checked"])
        locator.set_checked.side_effect = RuntimeError("checkbox did not change its state")
        page = Mock()
        page.locator.return_value.first = locator
        with self.assertRaisesRegex(RuntimeError, "did not change"):
            step_set_check(SimpleNamespace(page=page, dry_run=False), {"selector": "#scripts", "checked": False})
        locator.set_checked.assert_called_once_with(False)

    def test_dry_run_sends_no_input(self):
        page = Mock()
        step_set_check(SimpleNamespace(page=page, dry_run=True), {"selector": "#scripts", "checked": False})
        page.locator.assert_not_called()
