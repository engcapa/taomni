"""Host-only input ownership contracts; packaged behavior needs hosted native QA."""
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from . import mobile_native as probe


class DisableServiceTest(TestCase):
    def test_activates_focused_button_once_without_pointer_or_ipc(self):
        session = Mock()
        ctx = SimpleNamespace(session=session)
        with patch.object(probe, "until") as until:
            probe.disable_service(ctx)
        session.focus.assert_called_once_with('[data-testid="mobile-settings-toggle"]')
        session.press_combo.assert_called_once_with("Enter")
        session.click.assert_not_called()
        session.execute.assert_not_called()
        self.assertEqual(until.call_count, 2)
        self.assertIn(".disabled", until.call_args_list[0].args[1])
        self.assertIn('includes("Disabled")', until.call_args_list[1].args[1])
        self.assertEqual(session.method_calls, [
            ("focus", ('[data-testid="mobile-settings-toggle"]',), {}),
            ("press_combo", ("Enter",), {}),
        ])

    def test_failed_focus_does_not_activate_or_retry(self):
        session = Mock()
        session.focus.side_effect = RuntimeError("button unavailable")
        with patch.object(probe, "until"):
            with self.assertRaisesRegex(RuntimeError, "button unavailable"):
                probe.disable_service(SimpleNamespace(session=session))
        session.press_combo.assert_not_called()
        session.click.assert_not_called()

    def test_missing_stopped_state_still_fails_without_replaying_input(self):
        session = Mock()
        with patch.object(probe, "until", side_effect=[None, RuntimeError("still running")]):
            with self.assertRaisesRegex(RuntimeError, "still running"):
                probe.disable_service(SimpleNamespace(session=session))
        session.press_combo.assert_called_once_with("Enter")
        session.click.assert_not_called()
