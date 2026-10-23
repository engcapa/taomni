from unittest import TestCase
from unittest.mock import Mock, patch

from native_pointer import prepare_pointer_target
from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import CaseTimeout, Deadline


class NativePointerReadinessTest(TestCase):
    def setUp(self):
        self.now = 0.0
        clock = patch('native_pointer.time.monotonic', side_effect=lambda: self.now)
        sleeper = patch('native_pointer.time.sleep', side_effect=self.advance)
        clock.start()
        sleeper.start()
        self.addCleanup(clock.stop)
        self.addCleanup(sleeper.stop)
        self.session = Mock(deadline=None)
        self.session.endpoint.return_value = '/session/qa/execute/sync'
        self.origin = {'element-6066-11e4-a52e-4f735466cecf': 'row'}

    def advance(self, seconds):
        self.now += seconds

    def geometry(self, x=270, y=217, ready=True):
        return dict(x=x, y=y, width=420, height=24, ready=ready)

    def test_moving_row_must_settle_before_a_point_can_be_used(self):
        self.session.request.side_effect = [self.geometry(y=190), self.geometry(y=204),
                                            self.geometry(), self.geometry()]
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        self.assertEqual(self.session.request.call_count, 4)
        self.assertGreaterEqual(self.now, 0.15)
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))

    def test_covered_point_cannot_satisfy_stability_until_uncovered(self):
        self.session.request.side_effect = [self.geometry(ready=False), self.geometry(ready=False),
                                            self.geometry(), self.geometry()]
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        self.assertEqual(self.session.request.call_count, 4)

    def test_coverage_resets_an_earlier_stable_candidate(self):
        self.session.request.side_effect = [self.geometry(), self.geometry(ready=False),
                                            self.geometry(), self.geometry()]
        prepare_pointer_target(self.session, self.origin)
        self.assertEqual(self.session.request.call_count, 4)

    def test_layout_growth_scrolls_the_same_target_back_into_view_before_input(self):
        outside = {**self.geometry(ready=False), "outside": True}
        self.session.request.side_effect = [self.geometry(y=190), outside, None,
                                            self.geometry(), self.geometry()]
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        scroll = self.session.request.call_args_list[2]
        self.assertIn('scrollIntoView', scroll.args[2]['script'])
        self.assertEqual(scroll.args[2]['args'], [self.origin])
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))

    def test_persistent_overlay_fails_without_dispatching_input(self):
        self.session.request.return_value = self.geometry(ready=False)
        with self.assertRaisesRegex(WebDriverError, 'hit-testable'):
            prepare_pointer_target(self.session, self.origin, timeout=0.12)
        self.assertAlmostEqual(self.now, 0.12)
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))

    def test_invalid_geometry_cannot_fall_back_to_zero_or_last_point(self):
        for value in [None, {}, self.geometry(x=float('nan')), self.geometry(x=True), self.geometry(y='217')]:
            with self.subTest(value=value):
                self.session.request.return_value = value
                with self.assertRaisesRegex(WebDriverError, 'invalid native pointer'):
                    prepare_pointer_target(self.session, self.origin)

    def test_expired_case_budget_prevents_even_preparation(self):
        self.session.deadline = Deadline(-1)
        with self.assertRaises(CaseTimeout):
            prepare_pointer_target(self.session, self.origin)
        self.session.request.assert_not_called()

    def test_stale_node_is_reported_to_the_preparation_owner(self):
        self.session.request.side_effect = WebDriverError('stale element reference')
        with self.assertRaisesRegex(WebDriverError, 'stale element'):
            prepare_pointer_target(self.session, self.origin)
        self.session.request.assert_called_once()

    def test_visible_alternate_point_is_stable_and_only_enabled_explicitly(self):
        self.session.request.return_value = self.geometry(x=68)
        self.assertEqual(prepare_pointer_target(self.session, self.origin, allow_alternate=True),
                         {'x': 68, 'y': 217})
        self.assertTrue(all(c.args[2]['args'] == [self.origin, True] for c in self.session.request.call_args_list))
        self.session.request.reset_mock()
        prepare_pointer_target(self.session, self.origin)
        self.assertTrue(all(c.args[2]['args'] == [self.origin, False] for c in self.session.request.call_args_list))
