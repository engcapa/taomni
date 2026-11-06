"""Device-list synchronization contracts; real cancellation is hosted native QA."""
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from . import mobile_openssh as probe


class DeviceReadinessTest(TestCase):
    def test_refresh_requires_expected_count_not_a_stale_empty_list(self):
        session = Mock()
        with patch.object(probe, 'until') as until:
            probe.refresh_devices(SimpleNamespace(session=session), 2)
        session.focus.assert_called_once_with('[data-testid="mobile-settings-refresh"]')
        session.press_combo.assert_called_once_with('Enter')
        self.assertIn('.length === 2', until.call_args.args[1])
        self.assertIn('.disabled', until.call_args.args[1])
        session.count.assert_not_called()
        session.click.assert_not_called()

    def test_each_revoke_waits_for_ready_row_and_observed_removal(self):
        session = Mock()
        with patch.object(probe, 'until') as until:
            probe.revoke_devices(SimpleNamespace(session=session), 2)
        self.assertEqual(session.press_combo.call_count, 2)
        self.assertEqual([c.args[1].split('.length === ')[1].split(' ')[0]
                          for c in until.call_args_list], ['2', '1', '1', '0'])
        session.count.assert_not_called()
        session.click.assert_not_called()

    def test_missing_device_fails_before_any_revoke(self):
        session = Mock()
        with patch.object(probe, 'until', side_effect=RuntimeError('device not rendered')):
            with self.assertRaisesRegex(RuntimeError, 'device not rendered'):
                probe.revoke_devices(SimpleNamespace(session=session), 1)
        session.press_combo.assert_not_called()
