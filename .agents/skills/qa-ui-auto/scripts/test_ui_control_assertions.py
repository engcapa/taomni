from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import VERBS
from qa_ui_auto.steps import StepError, get
from qa_ui_auto.ui_control_assertions import observe


class ControlObservationTests(TestCase):
    def test_both_engines_read_the_same_style_and_focus(self):
        ctx = Mock(dry_run=False)
        for verb, args, value in [
            ("assert_computed_style", {"selector": "label", "property": "font-size", "equals": "18px"}, "18px"),
            ("assert_focus_on", "button.save", True),
            ("assert_focus_within", "dialog", True),
        ]:
            with self.subTest(verb=verb):
                ctx.page.evaluate.return_value = ctx.session.execute.return_value = {"count": 1, "value": value}
                self.assertEqual(get(verb)(ctx, args), VERBS[verb](ctx, args))

    def test_duplicate_matches_fail_even_when_the_first_value_matches(self):
        with patch("qa_ui_auto.ui_control_assertions.time.monotonic", side_effect=[0, 6]):
            with self.assertRaisesRegex(StepError, "expected one match"):
                observe("assert_focus_on", "button", lambda _: {"count": 2, "value": True})
