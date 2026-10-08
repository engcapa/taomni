from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.steps import StepContext, StepError
from qa_ui_auto.steps.navigation import step_open


class StartupNavigationTest(TestCase):
    def test_dynamic_import_network_change_retries_before_interaction(self):
        with TemporaryDirectory() as directory:
            page = Mock()
            ctx = StepContext(page, "TC-startup", Path(directory), {}, {})
            def navigate(*args, **kwargs):
                if page.goto.call_count == 1:
                    handler = page.on.call_args.args[1]
                    handler(SimpleNamespace(resource_type="script", failure="net::ERR_NETWORK_CHANGED"))
            page.goto.side_effect = navigate
            step_open(ctx, "http://127.0.0.1:5000/")
            self.assertEqual(page.goto.call_count, 2)
            self.assertIn("ERR_NETWORK_CHANGED", (Path(directory) / "startup-network-retries.log").read_text())
            page.remove_listener.assert_called_once_with("requestfailed", page.on.call_args.args[1])

    def test_product_startup_failure_is_not_retried(self):
        with TemporaryDirectory() as directory:
            page = Mock()
            page.wait_for_selector.side_effect = StepError("application did not mount")
            ctx = StepContext(page, "TC-startup", Path(directory), {}, {})
            with self.assertRaisesRegex(StepError, "application did not mount"):
                step_open(ctx, "/")
            self.assertEqual(page.goto.call_count, 1)
            self.assertFalse((Path(directory) / "startup-network-retries.log").exists())

    def test_static_html_prototype_uses_body_mount_gate(self):
        with TemporaryDirectory() as directory:
            page = Mock()
            page.wait_for_selector.side_effect = [RuntimeError("no React root"), None]
            ctx = StepContext(page, "TC-prototype", Path(directory), {}, {})
            step_open(ctx, "http://127.0.0.1:5000/docs-feature/ui-layout-refactor-prototype.html")
            self.assertEqual(page.wait_for_selector.call_args_list[0].args[0], "#root > *")
            self.assertEqual(page.wait_for_selector.call_args_list[1].args[0], "body > *")

    def test_persistent_network_failure_remains_a_failure(self):
        with TemporaryDirectory() as directory:
            page = Mock()
            page.goto.side_effect = RuntimeError("net::ERR_NO_BUFFER_SPACE")
            ctx = StepContext(page, "TC-startup", Path(directory), {}, {})
            with self.assertRaisesRegex(RuntimeError, "ERR_NO_BUFFER_SPACE"):
                step_open(ctx, "/")
            self.assertEqual(page.goto.call_count, 3)
            page.remove_listener.assert_called_once()
