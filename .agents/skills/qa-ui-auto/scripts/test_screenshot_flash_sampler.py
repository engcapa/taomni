import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from screenshot_flash_sampler import GRID, capture_source, grid, run, summarize, wall_clock_ns


class FlashSamplerTests(unittest.TestCase):
    def test_uniform_and_nonuniform_independent_pixel_grids(self):
        self.assertEqual(summarize([[255, 0, 255]] * (48 * 27)), (1.0, [255, 0, 255]))
        points = [[240, 20, 30] if i % 2 else [20, 80, 240] for i in range(48 * 27)]
        self.assertEqual(summarize(points)[0], 0.5)
        with self.assertRaises(ValueError):
            summarize([])

    def test_real_fresh_capture_called_per_sample_and_timestamps_kept(self):
        with TemporaryDirectory() as directory:
            stop = Path(directory) / "stop"
            count = 0
            def capture():
                nonlocal count
                count += 1
                if count == 2:
                    stop.write_text("stop")
                return {"points": [[count * 30, 0, 0]] * (48 * 27), "width": 100,
                        "height": 100, "transport": "test fresh pixels"}
            output = io.StringIO()
            with patch("screenshot_flash_sampler.time.sleep"):
                run(capture, output, stop)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([event["kind"] for event in events], ["sample", "sample", "stopped"])
            self.assertEqual([event["modalColor"] for event in events[:2]], [[30, 0, 0], [60, 0, 0]])
            self.assertLessEqual(events[0]["captureEndedMonoMs"], events[1]["captureStartedMonoMs"])
            self.assertNotIn("points", events[0])

    def test_windows_capture_brackets_use_precise_utc_and_qpc_not_quantized_ticks(self):
        with TemporaryDirectory() as directory:
            stop = Path(directory) / "stop"
            def capture():
                stop.write_text("stop")
                return {"points": [[1, 2, 3]] * (48 * 27), "width": 100,
                        "height": 100, "transport": "test"}
            output = io.StringIO()
            with patch("screenshot_flash_sampler.wall_clock_ns", return_value=Mock(side_effect=[
                    1_700_000_000_000_000_000, 1_700_000_000_031_200_000])), \
                 patch("screenshot_flash_sampler.time.perf_counter_ns", side_effect=[1_000_000_000, 1_031_200_000]), \
                 patch("screenshot_flash_sampler.time.monotonic_ns", side_effect=AssertionError("quantized tick clock")), \
                 patch("screenshot_flash_sampler.time.time_ns", side_effect=AssertionError("coarse UTC clock")), \
                 patch("screenshot_flash_sampler.time.sleep"):
                run(capture, output, stop)
            first = json.loads(output.getvalue().splitlines()[0])
            self.assertAlmostEqual(first["captureEndedMonoMs"] - first["captureStartedMonoMs"], 31.2)
            self.assertAlmostEqual(first["captureEndedMs"] - first["captureStartedMs"], 31.2, places=3)

    @unittest.skipUnless(__import__("sys").platform == "win32", "Windows precise UTC API")
    def test_windows_precise_wall_clock_preserves_real_utc_epoch(self):
        import time
        precise = wall_clock_ns()
        self.assertLess(abs(precise() - time.time_ns()), 100_000_000)

    def test_shell_capture_timestamp_is_not_replaced_by_delivery_time(self):
        with TemporaryDirectory() as directory:
            stop = Path(directory) / "stop"
            def capture():
                stop.write_text("stop")
                return {"points": [[50, 60, 70]] * (48 * 27), "width": 100,
                        "height": 100, "transport": "Shell test", "captureStartedMs": 123,
                        "captureEndedMs": 124, "captureStartedMonoMs": 456, "captureEndedMonoMs": 457}
            output = io.StringIO()
            with patch("screenshot_flash_sampler.time.sleep"):
                run(capture, output, stop)
            first = json.loads(output.getvalue().splitlines()[0])
            self.assertEqual(first["captureStartedMs"], 123)
            self.assertEqual(first["captureEndedMs"], 124)
            self.assertEqual(first["captureStartedMonoMs"], 456)

    def test_hard_lifetime_is_a_failure_not_a_green_stop(self):
        with TemporaryDirectory() as directory:
            output, capture = io.StringIO(), Mock()
            with patch("screenshot_flash_sampler.time.perf_counter", side_effect=[0, 46]):
                with self.assertRaisesRegex(RuntimeError, "finite lifetime"):
                    run(capture, output, Path(directory) / "stop")
            self.assertEqual(output.getvalue(), "")
            capture.assert_not_called()

    def test_wayland_source_uses_only_fixed_owned_broker_capture(self):
        command = Mock(return_value={"points": []})
        with patch.dict("os.environ", {"GDK_BACKEND": "wayland"}), \
             patch("qa_ui_auto.wayland.command", command):
            capture = capture_source({"x": 1920, "y": 0, "width": 2560, "height": 1440}, 2)
            capture()
        command.assert_called_once_with("capture_grid", rect={"x": 960, "y": 0, "width": 1280, "height": 720})

    def test_grid_samples_actual_fresh_image_pixels(self):
        from PIL import Image
        image = Image.new("RGB", (96, 54), (15, 80, 210))
        points = grid(image)
        self.assertEqual(len(points), GRID[0] * GRID[1])
        self.assertEqual(points, [(15, 80, 210)] * (48 * 27))
