from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.native_steps import VERBS, NativeStepContext
from qa_ui_auto.steps import StepError
from qa_ui_auto.steps.windows import switch_window
from qa_ui_auto.steps.assertions import step_assert_value
from qa_ui_auto.steps.persistence import step_seed_storage
from qa_ui_auto.window_routes import matches_window_route


class FakeSession:
    def __init__(self):
        self.selected = "main"
        self.urls = {"main": "tauri://localhost/", "git": "tauri://localhost/#git=fixture"}
        self.install_console_hook = Mock()
        self.restart = Mock()

    def endpoint(self, suffix):
        return suffix

    def request(self, method, endpoint, payload=None):
        if endpoint == "/window/handles":
            return list(self.urls)
        if endpoint == "/window" and method == "POST":
            self.selected = payload["handle"]
        if endpoint == "/url":
            return self.urls[self.selected]


class ShellWindowsTest(TestCase):
    def test_raw_seed_requires_explicit_opt_in_and_an_app_key(self):
        ctx = Mock(dry_run=False)
        with self.assertRaisesRegex(StepError, "valid JSON"):
            step_seed_storage(ctx, {"key": "taomni.shellLayout.v2", "value": "{broken"})
        ctx.page.evaluate.assert_not_called()
        with self.assertRaisesRegex(StepError, "taomni"):
            step_seed_storage(ctx, {"key": "foreign", "value": "{broken", "raw": True})
        step_seed_storage(ctx, {"key": "taomni.shellLayout.v2", "value": "{broken", "raw": True})
        self.assertEqual(ctx.page.evaluate.call_args.args[1], ["taomni.shellLayout.v2", "{broken"])

    def test_native_raw_seed_passes_a_literal_without_interpolating_code(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.execute = Mock()
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["seed_storage"](ctx, {"key": "taomni.shellLayout.v2", "value": "{broken\n'\\", "raw": True})
            self.assertIn('"{broken\\n\'\\\\"', session.execute.call_args.args[0])
            with self.assertRaisesRegex(StepError, "valid JSON"):
                VERBS["seed_storage"](ctx, {"key": "taomni.shellLayout.v2", "value": "{broken"})

    def test_query_child_is_not_main_but_other_query_is_allowed(self):
        self.assertFalse(matches_window_route("http://localhost/?sftp=fixture", ""))
        self.assertFalse(matches_window_route("tauri://localhost/#git=fixture", ""))
        self.assertTrue(matches_window_route("http://localhost/?qa=1", ""))

    def test_native_main_selection_excludes_query_child(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.urls = {"child": "tauri://localhost/?sftp=fixture", "main": "tauri://localhost/"}
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["switch_window"](ctx, {"route": ""})
            self.assertEqual(session.selected, "main")

    def test_input_property_uses_single_argument_and_quotes_selector(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            # A strict one-argument callable catches the NativeSession signature.
            scripts = []
            def execute(script):
                scripts.append(script)
                return "edited\n完整"
            session.execute = execute
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["assert_value"](ctx, {"selector": 'input[data-label="a\\b"]', "equals": "edited\n完整"})
            self.assertIn('document.querySelector("input[data-label=\\"a\\\\b\\"]")?.value', scripts[0])

    def test_browser_input_property_and_mismatch(self):
        ctx = Mock(dry_run=False)
        ctx.page.locator.return_value.first.input_value.return_value = "edited"
        step_assert_value(ctx, {"selector": "input", "equals": "edited"})
        with self.assertRaisesRegex(StepError, "input value"):
            step_assert_value(ctx, {"selector": "input", "equals": "other", "timeout_sec": .01})

    def test_native_selects_an_existing_child_and_can_return_to_main(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["switch_window"](ctx, {"route": "#git="})
            self.assertEqual(session.selected, "git")
            VERBS["switch_window"](ctx, {"route": ""})
            self.assertEqual(session.selected, "main")
            VERBS["restart_native_app"](ctx, None)
            session.restart.assert_called_once()

    def test_missing_child_is_a_failure(self):
        with TemporaryDirectory() as directory:
            ctx = NativeStepContext(FakeSession(), Path(directory), {})
            with self.assertRaisesRegex(StepError, "no native window"):
                VERBS["switch_window"](ctx, {"route": "#missing=", "timeout_sec": .01})

    def test_browser_switches_pages_without_creating_one(self):
        root = Mock(url="http://localhost/", is_closed=Mock(return_value=False))
        child = Mock(url="http://localhost/#sftp=fixture", is_closed=Mock(return_value=False))
        root.context.pages = [root, child]
        ctx = Mock(page=root, dry_run=False)
        switch_window(ctx, {"route": "#sftp="})
        self.assertIs(ctx.page, child)
        child.bring_to_front.assert_called_once()
