from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch
import json

from qa_ui_auto.native_steps import VERBS, NativeStepContext
from qa_ui_auto.steps import StepError
from qa_ui_auto.steps.windows import switch_window, click_window_close
from qa_ui_auto.steps.assertions import step_assert_value
from qa_ui_auto.steps.persistence import step_seed_storage
from qa_ui_auto.window_routes import matches_window_route
from tauri_webdriver import WebDriverError


class FakeSession:
    def __init__(self):
        self.selected = "main"
        self.urls = {"main": "tauri://localhost/", "git": "tauri://localhost/#git=fixture"}
        self.install_console_hook = Mock()
        self.wait_for_app_ready = Mock()
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
    def test_child_routes_are_parameters_in_fragment_or_query(self):
        self.assertTrue(matches_window_route("tauri://localhost/?git=fixture", "#git="))
        self.assertTrue(matches_window_route("tauri://localhost/#git=fixture", "?git="))
        self.assertFalse(matches_window_route("tauri://localhost/?other=%23git%3Dfixture", "#git="))
        self.assertFalse(matches_window_route("tauri://localhost/path/git=fixture", "#git="))

    def test_interruption_schedules_a_native_command_only_for_selected_child(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(side_effect=["tauri://localhost/#notes=fixture", {"scheduled": True}])
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["interrupt_detached_window"](ctx, "#notes=")
            method, endpoint, payload = session.request.call_args.args
            self.assertEqual((method, endpoint), ("POST", "/execute/sync"))
            self.assertEqual(payload["args"], [])
            self.assertIn("close_current_detached_window", payload["script"])
            self.assertIn("return {scheduled: true}", payload["script"])

    def test_normal_close_requests_tauri_lifecycle_instead_of_deleting_webview_target(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(return_value={"scheduled": True})
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["close_window"](ctx, None)
            method, endpoint, payload = session.request.call_args.args
            self.assertEqual((method, endpoint), ("POST", "/execute/sync"))
            self.assertIn("getCurrentWindow()", payload["script"])
            self.assertIn("selected.close()", payload["script"])
            session.request.return_value = None
            with self.assertRaisesRegex(StepError, "not scheduled"):
                VERBS["close_window"](ctx, None)

    def test_interruption_rejects_main_wrong_route_and_missing_dispatch_ack(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            ctx = NativeStepContext(session, Path(directory), {})
            with self.assertRaisesRegex(StepError, "supported child route"):
                VERBS["interrupt_detached_window"](ctx, "")
            for url in ["tauri://localhost/", "tauri://localhost/#sftp=fixture", "tauri://localhost/?other=%23notes%3Dfixture"]:
                session.request = Mock(return_value=url)
                with self.assertRaisesRegex(StepError, "not the requested"):
                    VERBS["interrupt_detached_window"](ctx, "#notes=")
                self.assertEqual(session.request.call_count, 1)
            session.request = Mock(side_effect=["tauri://localhost/#notes=fixture", None])
            with self.assertRaisesRegex(StepError, "not scheduled"):
                VERBS["interrupt_detached_window"](ctx, "#notes=")

    def test_window_count_keeps_hidden_handles_and_failed_samples(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(return_value=["main", "hidden-child"])
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["assert_native_window_count"](ctx, {"equal": 2})
            with patch("qa_ui_auto.native_steps.time.monotonic", side_effect=[0, 0, 2]), patch("qa_ui_auto.native_steps.time.sleep"):
                with self.assertRaisesRegex(StepError, "does not equal 1"):
                    VERBS["assert_native_window_count"](ctx, {"equal": 1, "timeout_sec": 1})
            records = [json.loads(line) for line in (Path(directory) / "native-window-counts.jsonl").read_text().splitlines()]
            self.assertTrue(records[0]["passed"])
            self.assertFalse(records[1]["passed"])
            self.assertEqual(records[1]["samples"][0]["handles"], ["main", "hidden-child"])

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

    def test_main_selection_tolerates_only_a_retired_window_handle(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(side_effect=[
                ["closed-child", "main"], WebDriverError("no such window"), None, "tauri://localhost/",
            ])
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["switch_window"](ctx, {"route": ""})
            session.wait_for_app_ready.assert_called_once_with()
            session.request = Mock(side_effect=[["main"], WebDriverError("driver disconnected")])
            with self.assertRaisesRegex(WebDriverError, "driver disconnected"):
                VERBS["switch_window"](ctx, {"route": ""})

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
            session.wait_for_app_ready.assert_called_once()
            VERBS["switch_window"](ctx, {"route": ""})
            self.assertEqual(session.selected, "main")
            VERBS["restart_native_app"](ctx, None)
            session.restart.assert_called_once()

    def test_native_resize_compensates_for_window_chrome_and_checks_client_size(self):
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(side_effect=[{"width": 1016, "height": 839}, None])
            session.execute = Mock(side_effect=[{"width": 1000, "height": 800}, {"width": 1440, "height": 900}])
            ctx = NativeStepContext(session, Path(directory), {})
            VERBS["set_viewport"](ctx, {"width": 1440, "height": 900})
            self.assertEqual(session.request.call_args_list[1].args, ("POST", "/window/rect", {"width": 1456, "height": 939}))
            self.assertEqual(session.execute.call_count, 2)

    def test_native_resize_rejects_a_window_that_never_reaches_requested_viewport(self):
        from unittest.mock import patch
        with TemporaryDirectory() as directory:
            session = FakeSession()
            session.request = Mock(return_value={"width": 900, "height": 700})
            session.execute = Mock(return_value={"width": 900, "height": 700})
            ctx = NativeStepContext(session, Path(directory), {})
            with patch("qa_ui_auto.native_steps.time.monotonic", side_effect=[0, 11]):
                with self.assertRaisesRegex(StepError, "did not reach"):
                    VERBS["set_viewport"](ctx, {"width": 1440, "height": 900})

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

    def test_browser_pumps_popup_discovery_before_selecting_new_child(self):
        root = Mock(url="http://localhost/", is_closed=Mock(return_value=False))
        child = Mock(url="http://localhost/?servers=main", is_closed=Mock(return_value=False))
        root.context.pages = [root]
        root.wait_for_timeout.side_effect = lambda _: root.context.pages.append(child)
        ctx = Mock(page=root, dry_run=False)
        switch_window(ctx, {"route": "#servers="})
        root.wait_for_timeout.assert_called_once_with(100)
        self.assertIs(ctx.page, child)
        child.bring_to_front.assert_called_once()

    def test_self_closing_control_requires_the_real_page_close_event(self):
        from contextlib import nullcontext
        from playwright.sync_api import Error
        page = Mock()
        page.expect_event.return_value = nullcontext()
        page.locator.return_value.first.click.side_effect = Error("target closed")
        page.is_closed.return_value = True
        ctx = Mock(page=page, dry_run=False)
        click_window_close(ctx, "#cancel")
        page.expect_event.assert_called_once_with("close", timeout=10000)
        page.locator.assert_called_once_with("#cancel")
        page.is_closed.return_value = False
        with self.assertRaisesRegex(Error, "target closed"):
            click_window_close(ctx, "#cancel")
