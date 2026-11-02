import unittest
from unittest.mock import Mock

from ci_wayland_capture import CAPTURE_GRID, capture_grid


RECT = {"x": 0, "y": 0, "width": 1920, "height": 1080}


def evidence():
    return {"captureStartedMs": 1000, "captureEndedMs": 1002,
            "captureStartedMonoMs": 500, "captureEndedMonoMs": 502,
            "width": 1920, "height": 1080,
            "points": [[90, 80, 70] for _ in range(48 * 27)],
            "transport": "owned GNOME Shell.Screenshot stage pixels (no portal)"}


class WaylandCaptureTests(unittest.TestCase):
    def test_fixed_capture_uses_actual_stage_pixels_without_a_portal_or_flash(self):
        evaluate = Mock(return_value=evidence())
        result = capture_grid(evaluate, RECT)
        self.assertEqual(result, evidence())
        script = evaluate.call_args.args[0]
        self.assertIn("screenshot_stage_to_content()", script)
        self.assertIn("Shell.Screenshot.composite_to_stream(", script)
        self.assertIn("pixbuf.get_pixels()", script)
        self.assertIn("Date.now()", script)
        self.assertIn("GLib.get_monotonic_time()", script)
        self.assertIn("stream.close(null)", script)
        self.assertNotIn("org.freedesktop.portal", script)
        self.assertNotIn("FlashArea", script)
        self.assertNotIn("captureScreenshot(", script)  # notification/sound UI wrapper
        self.assertNotIn("RECT", script)
        self.assertLess(script.index("captureStartedMs ="), script.index("screenshot_stage_to_content()"))
        self.assertLess(script.index("captureEndedMs ="), script.index("await pending"))

    def test_invalid_rectangles_never_reach_shell_eval(self):
        for rect in (None, {}, {**RECT, "width": 0}, {**RECT, "x": -1},
                     {**RECT, "width": True}, {**RECT, "height": 20000},
                     {**RECT, "code": "dangerous()"}):
            with self.subTest(rect=rect):
                evaluate = Mock()
                with self.assertRaises(ValueError):
                    capture_grid(evaluate, rect)
                evaluate.assert_not_called()

    def test_missing_stale_or_malformed_pixels_cannot_pass(self):
        for bad in (None, {}, {**evidence(), "points": []},
                    {**evidence(), "captureEndedMs": 999},
                    {**evidence(), "captureStartedMonoMs": float("nan")},
                    {**evidence(), "width": 0},
                    {**evidence(), "points": [[256, 0, 0]] * (48 * 27)}):
            with self.subTest(kind=type(bad).__name__), self.assertRaises(RuntimeError):
                capture_grid(Mock(return_value=bad), RECT)

    def test_capture_does_not_accept_a_non_monitor_region(self):
        self.assertIn("if (!monitor)", CAPTURE_GRID)
        self.assertIn("m.width === rect.width", CAPTURE_GRID)
        self.assertIn("Math.round(rect.x * scale)", CAPTURE_GRID)

    def test_broker_failures_are_not_skips(self):
        with self.assertRaisesRegex(RuntimeError, "permission denied"):
            capture_grid(Mock(side_effect=RuntimeError("permission denied")), RECT)
