import json
import os
from pathlib import Path
import stat
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory
from unittest import TestCase, skipUnless
from unittest.mock import Mock, call, patch

from qa_ui_auto import native_steps
from qa_ui_auto.deadline import Deadline
from tauri_webdriver import NativeHarness, NativeSession, TauriDriverProcess, WebDriverError, selector_strategy


class NativeSessionTransportTest(TestCase):
    def test_wayland_auxiliary_backend_is_private_to_the_application_driver(self):
        with TemporaryDirectory() as root, patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "wayland"}), \
                patch("tauri_webdriver._tcp_ok", side_effect=[False, False, True, True]), \
                patch("tauri_webdriver.subprocess.Popen") as launch:
            launch.return_value.poll.return_value = None
            TauriDriverProcess({"app": {"native_binary": str(Path(root) / "qa-app")}}, Path(root)).start()
            self.assertEqual(launch.call_args.kwargs["env"]["GDK_BACKEND"], "wayland,x11")
            self.assertEqual(os.environ["GDK_BACKEND"], "wayland")

    def test_modified_click_holds_keys_through_pointer_up_and_releases_them_on_failure(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(side_effect=[None, WebDriverError("input failed"), None])
        with self.assertRaisesRegex(WebDriverError, "input failed"):
            session.pointer_button_click("#row", 0, ["Control", "Shift"])
        keys, pointer = session.request.call_args_list[1].args[2]["actions"]
        self.assertEqual(pointer["id"], "mouse")
        self.assertEqual(len(keys["actions"]), len(pointer["actions"]))
        self.assertEqual(keys["actions"][:2], [{"type": "keyDown", "value": "\ue009"}, {"type": "keyDown", "value": "\ue008"}])
        self.assertEqual(keys["actions"][-2:], [{"type": "keyUp", "value": "\ue008"}, {"type": "keyUp", "value": "\ue009"}])
        self.assertEqual(pointer["actions"][3:5], [{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}])
        self.assertEqual(session.request.call_args, call("DELETE", "/session/session-1/actions"))

    def test_close_has_its_own_budget_after_case_or_diagnostics_timeout(self):
        closed = Mock()
        session = NativeSession("http://driver.invalid", Path("unused"), closed)
        session.session_id = "expired-session"
        session.deadline = Deadline(-1)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"value": null}'
        session._open = Mock(return_value=response)
        session.close()
        request = session._open.call_args.args[0]
        self.assertEqual(request.method, "DELETE")
        self.assertTrue(request.full_url.endswith("/session/expired-session"))
        self.assertGreater(session._open.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(session._open.call_args.kwargs["timeout"], 5)
        closed.assert_called_once_with()

    def test_close_releases_transport_and_owner_without_a_session_id(self):
        # POST /session can time out after the driver has spawned the app.
        closed = Mock()
        session = NativeSession("http://driver.invalid", Path("unused"), closed)
        connection = Mock()
        session._connection = connection
        session.close()
        session.close()
        connection.close.assert_called_once_with()
        closed.assert_called_once_with()

    def test_explicit_xpath_preserves_exact_candidate_text_matching(self):
        xpath = "//span[normalize-space(.)='String']"
        self.assertEqual(selector_strategy("xpath=" + xpath, interactive=True), ("xpath", xpath))

    def test_per_case_java_runtime_does_not_leak_into_next_session(self):
        harness = NativeHarness({"app": {"tooling_java_home": "/jdk21"}}, Path("/qa/run"))
        harness.driver = Mock()
        with patch("tauri_webdriver.NativeSession") as factory:
            harness.create_session(tooling_java_home="/jdk25")
            self.assertIn('"/jdk25"', factory.return_value.execute.call_args.args[0])
            harness.create_session()
            self.assertIn('"/jdk21"', factory.return_value.execute.call_args.args[0])
        self.assertEqual(harness.cfg["app"]["tooling_java_home"], "/jdk21")

    def test_windows_driver_uses_the_apps_isolated_webview_profile(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.request = Mock(return_value={"sessionId": "session-1"})
        session.wait_for_app_ready = Mock()
        session.install_console_hook = Mock()
        with patch("tauri_webdriver.platform.system", return_value="Windows"), \
             patch.dict(os.environ, {"NEWMOB_DATA_DIR": "/qa/run/native-appdata"}):
            session.start()
        options = session.request.call_args.args[2]["capabilities"]["alwaysMatch"]["tauri:options"]
        self.assertEqual(options["webviewOptions"]["userDataFolder"],
                         str(Path("/qa/run/native-appdata/com.taomni.app.qa/webview")))

    def test_wayland_start_activates_the_actual_webdriver_window(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.request = Mock(side_effect=[{"sessionId": "session-1"}, "window-qa", None])
        session.wait_for_app_ready = Mock()
        session.install_console_hook = Mock()
        session.execute = Mock(side_effect=[False, False, True])
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "wayland"}), \
                patch("tauri_webdriver.time.sleep"):
            session.start()
        self.assertEqual(session.request.call_args_list[-2:], [
            call("GET", "/session/session-1/window"),
            call("POST", "/session/session-1/window", {"handle": "window-qa"}),
        ])
        session.execute.assert_called_with("return document.hasFocus();")
        session.install_console_hook.assert_called_once_with()

    def test_x11_activation_requires_os_and_webview_focus(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=["qa-window", None])
        session.execute = Mock(side_effect=[False, False, True])
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
             patch.dict(os.environ, {"GDK_BACKEND": "x11"}), \
             patch("qa_ui_auto.native_steps._activate_x11_application") as activate, \
             patch("tauri_webdriver.time.sleep"):
            session.activate_linux_window()
        activate.assert_called_once_with(session.application)
        session.request.assert_called_with("POST", "/session/session-1/window", {"handle": "qa-window"})
        self.assertEqual(session.focus_warning, "")

    def test_x11_activation_failure_is_reported_instead_of_failing_the_session(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock()
        session.execute = Mock(return_value=False)
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
             patch.dict(os.environ, {"GDK_BACKEND": "x11"}), \
             patch("qa_ui_auto.native_steps._activate_x11_application",
                   side_effect=native_steps.StepError("native X11: no window belongs to taomni")), \
             patch("tauri_webdriver.time.sleep"):
            session.activate_linux_window()
        self.assertIn("no window belongs to taomni", session.focus_warning)
        session.request.assert_not_called()

    def test_wayland_unfocused_document_fails_before_starting_app_steps(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=["window-qa", None])
        session.execute = Mock(return_value=False)
        with self.assertRaisesRegex(WebDriverError, "window did not receive focus"):
            session.activate_wayland_window(timeout=0)
        self.assertEqual(session.execute.call_count, 2)
        session.execute.assert_called_with("return document.hasFocus();")

    def test_wayland_start_requests_owned_desktop_activation_when_document_is_unfocused(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=["window-qa", None])
        session.execute = Mock(side_effect=[False, True])
        with patch.dict(os.environ, {"QA_WAYLAND_INPUT_SOCKET": "/qa/private/input.sock"}), \
                patch("tauri_webdriver.socket.AF_UNIX", 1, create=True), \
                patch("tauri_webdriver.socket.socket") as factory:
            connection = factory.return_value.__enter__.return_value
            connection.recv.return_value = b'{"ok":true}\n'
            session.activate_wayland_window()
        connection.connect.assert_called_once_with("/qa/private/input.sock")
        request = json.loads(connection.sendall.call_args.args[0])
        self.assertEqual(request, {"command": "activate", "application": str(Path("/tmp/taomni").resolve())})
        session.request.assert_called_with("POST", "/session/session-1/window", {"handle": "window-qa"})

    def test_right_click_uses_right_button_and_releases_on_failure(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(side_effect=[None, RuntimeError("input failed"), None])
        with self.assertRaisesRegex(RuntimeError, "input failed"):
            session.right_click("#file")
        actions = session.request.call_args_list[1].args[2]["actions"][0]["actions"]
        self.assertEqual(actions[0]["origin"], {"element-6066-11e4-a52e-4f735466cecf": "row-1"})
        self.assertEqual([a["button"] for a in actions[1:]], [2, 2])
        self.assertEqual(session.request.call_args.args, ("DELETE", "/session/session-1/actions"))
        self.assertNotIn("dispatchEvent", session.request.call_args_list[0].args[2]["script"])

    def test_pointer_click_retries_a_stale_element_reference(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(side_effect=["row-1", "row-2"])
        session.request = Mock(side_effect=[
            WebDriverError("stale element reference: element is not attached to the page document"),
            None,
            None,
            None,
            None,
        ])
        with patch("tauri_webdriver.time.sleep") as sleep:
            session.right_click("#file")
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        # The retry re-resolves the row and dispatches against the fresh node.
        actions_call = next(
            call for call in session.request.call_args_list if call.args[0] == "POST" and call.args[1].endswith("/actions")
        )
        actions = actions_call.args[2]["actions"][0]["actions"]
        self.assertEqual(actions[0]["origin"], {"element-6066-11e4-a52e-4f735466cecf": "row-2"})
        self.assertEqual([a["button"] for a in actions[1:]], [2, 2])

    def test_click_retries_webkit_stale_element_error(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(side_effect=["button-1", "button-2"])
        session.request = Mock(side_effect=[
            WebDriverError('HTTP 400: {"message":"JavaScript error: Error: stale element"}'),
            None,
            None,
        ])
        with patch("tauri_webdriver.time.sleep") as sleep:
            session.click("#section")
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        click_urls = [
            call.args[1] for call in session.request.call_args_list
            if call.args[0] == "POST" and call.args[1].endswith("/click")
        ]
        self.assertEqual(click_urls, ["/session/session-1/element/button-1/click", "/session/session-1/element/button-2/click"])

    def test_pointer_click_retries_a_null_element_scroll_error(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(side_effect=["row-1", "row-2"])
        session.request = Mock(side_effect=[
            WebDriverError(
                'HTTP 400: {"value":{"error":"unknown error","message":"JavaScript error: '
                "TypeError: null is not an object (evaluating 'arguments[0].scrollIntoView')\"}}"
            ),
            None,
            None,
            None,
            None,
        ])
        with patch("tauri_webdriver.time.sleep") as sleep:
            session.right_click("#file")
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        actions_call = next(
            call for call in session.request.call_args_list if call.args[0] == "POST" and call.args[1].endswith("/actions")
        )
        actions = actions_call.args[2]["actions"][0]["actions"]
        self.assertEqual(actions[0]["origin"], {"element-6066-11e4-a52e-4f735466cecf": "row-2"})

    def test_pointer_click_gives_up_after_three_stale_references(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(side_effect=[
            WebDriverError("stale element reference"),
            None,
            WebDriverError("stale element reference"),
            None,
            WebDriverError("stale element reference"),
            None,
        ])
        with patch("tauri_webdriver.time.sleep"):
            with self.assertRaisesRegex(WebDriverError, "stale element reference"):
                session.right_click("#file")
        self.assertEqual(session.find.call_count, 3)

    def test_count_accepts_empty_but_rejects_invalid_driver_response(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=[[], {"error": "bad response"}])
        self.assertEqual(session.count(".tab"), 0)
        with self.assertRaisesRegex(Exception, "invalid element list"):
            session.count(".tab")

    def test_scoped_press_activates_webview_without_clicking_target(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(return_value=True)
        session.press_combo = Mock(return_value="pressed")
        session.activate_linux_window = Mock()
        ctx = Mock(session=session)
        native_steps._press(ctx, {"selector": "#folder", "key": "ArrowRight"})
        session.press_combo.assert_called_once_with("ArrowRight")
        session.activate_linux_window.assert_called_once_with()
        session.request.assert_called_once()
        self.assertTrue(session.request.call_args.args[1].endswith("/execute/sync"))
        self.assertEqual(session.request.call_args.args[2]["args"], [{"element-6066-11e4-a52e-4f735466cecf": "row-1"}])

    def test_failed_focus_does_not_send_keys_to_previous_target(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(return_value=False)
        session.press_combo = Mock()
        with self.assertRaisesRegex(Exception, "could not receive focus"):
            native_steps._press(Mock(session=session), {"selector": "#folder", "key": "ArrowRight"})
        session.press_combo.assert_not_called()

    def test_loopback_driver_bypasses_system_proxy(self):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def do_GET(self):
                self.server.observed.append((self.client_address, self.headers.get('Connection')))
                self.send_response(200)
                self.send_header('Content-Length', '26')
                self.end_headers()
                self.wfile.write(b'{"value": {"ready": true}}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.observed = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch("urllib.request.getproxies", return_value={"http": "http://127.0.0.1:1"}):
                session = NativeSession(f"http://127.0.0.1:{server.server_port}", Path("unused"))
                self.assertEqual(session.request("GET", "/status"), {"ready": True})
                self.assertEqual(session.request("GET", "/status"), {"ready": True})
                self.assertEqual(server.observed[0][0], server.observed[1][0])
                self.assertNotIn('close', [connection for _, connection in server.observed])
                session._connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_session_waits_for_react_root_before_installing_hooks(self):
        # WebView2 sessions can start on about:blank, where localStorage
        # access is denied; every platform must wait for the app document.
        for system in ("Darwin", "Windows", "Linux"):
            with self.subTest(system=system):
                session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
                session.request = Mock(return_value={"sessionId": "session-1"})
                session.execute = Mock(side_effect=[
                    WebDriverError("Failed to read the 'localStorage' property"), False, True])
                session.install_console_hook = Mock()
                session.activate_linux_window = Mock()
                with patch("tauri_webdriver.platform.system", return_value=system), \
                     patch.dict(os.environ, {"NEWMOB_DATA_DIR": "/qa/run/native-appdata"}):
                    session.start()

                self.assertEqual(session.session_id, "session-1")
                self.assertEqual(session.execute.call_count, 3)
                self.assertIn("document.readyState", session.execute.call_args_list[0].args[0])
                session.install_console_hook.assert_called_once_with()

    def test_failed_session_readiness_deletes_session_so_app_exits(self):
        # An undeleted session leaves the app running with the run-owned
        # profile locked, so every later case's reset_db fails (WinError 32).
        harness = NativeHarness({"app": {"tooling_java_home": "/jdk21"}}, Path("/qa/run"))
        harness.driver = Mock()
        with patch("tauri_webdriver.NativeSession") as factory:
            session = factory.return_value
            session.execute.side_effect = WebDriverError("Access is denied for this document")
            with self.assertRaisesRegex(WebDriverError, "Access is denied"):
                harness.create_session()
        session.close.assert_called_once_with()
        harness.driver.mark_session_closed.assert_called_once_with()

    def test_failed_session_cleanup_preserves_original_error(self):
        harness = NativeHarness({"app": {}}, Path("/qa/run"))
        harness.driver = Mock()
        harness.driver.mark_session_closed.side_effect = WebDriverError("could not stop owned tree")
        with patch("tauri_webdriver.NativeSession") as factory:
            session = factory.return_value
            session.start.side_effect = WebDriverError("session not created")
            session.close.side_effect = WebDriverError("no such session")
            with self.assertRaisesRegex(WebDriverError, "session not created"):
                harness.create_session()
        harness.driver.mark_session_closed.assert_called_once_with()


class NativeSessionFillTest(TestCase):
    def session(self, contenteditable: bool, focus_results: list[bool] | None = None) -> NativeSession:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.find = Mock(return_value="element-1")
        session.request = Mock(return_value=None)
        execute_results: list[bool] = [contenteditable]
        if contenteditable:
            execute_results.extend(focus_results or [True])
        else:
            execute_results.append(False)
        session.execute = Mock(side_effect=execute_results)
        session.press_combo = Mock(return_value="")
        session.type_text = Mock(return_value="")
        return session

    def test_contenteditable_fill_uses_real_key_actions(self) -> None:
        session = self.session(True)

        result = session.fill(".cm-content", "cafe\r\nmatrix\n")

        self.assertEqual(result, "filled contenteditable .cm-content")
        session.execute.assert_any_call(
            'const el = document.querySelector(".cm-content");'
            "return !!el?.isContentEditable;"
        )
        session.execute.assert_any_call(
            'const el = document.querySelector(".cm-content");'
            "return !!el && document.activeElement === el;"
        )
        session.press_combo.assert_has_calls([
            call("Control+a"),
            call("Enter"),
            call("Enter"),
        ])
        session.type_text.assert_has_calls([call("cafe"), call("matrix")])
        self.assertFalse(any(args[1].endswith("/value") for args, _ in session.request.call_args_list))

    def test_contenteditable_fill_retries_real_click_until_focused(self) -> None:
        session = self.session(True, [False, True])

        session.fill(".cm-content", "text")

        click_call = call("POST", "/session/session-1/element/element-1/click", {})
        self.assertEqual(session.request.call_args_list.count(click_call), 2)

    def test_input_fill_keeps_blur_committing_control_focused(self) -> None:
        session = self.session(False)

        result = session.fill("input[name=title]", "Taomni")

        self.assertEqual(result, "filled input[name=title]")
        self.assertNotIn(
            call("POST", "/session/session-1/element/element-1/clear", {}),
            session.request.call_args_list,
        )
        self.assertFalse(any(c.args[1].endswith('/value') for c in session.request.call_args_list))
        session.press_combo.assert_has_calls([call("Mod+a"), call("Backspace")])
        session.type_text.assert_called_once_with("Taomni")

    def test_empty_password_fill_deletes_and_observes_value_without_empty_value_request(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, False, True])
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "x11"}), patch("tauri_webdriver.time.sleep"):
            session.fill('input[type=password]', '')
        session.press_combo.assert_has_calls([call("Mod+a"), call("Backspace")])
        self.assertTrue(all(request.args[1].endswith('/click') for request in session.request.call_args_list))
        session.type_text.assert_not_called()

    def test_empty_fill_rejects_a_control_that_retains_its_old_value(self) -> None:
        session = self.session(False)
        session.execute = Mock(return_value=False)
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "x11"}), \
                patch("tauri_webdriver.time.monotonic", side_effect=[0, 6]):
            with self.assertRaisesRegex(WebDriverError, 'did not clear'):
                session.fill('input[type=password]', '')
        session.type_text.assert_not_called()

    def test_empty_contenteditable_fill_deletes_the_selection(self) -> None:
        session = self.session(True)
        session.fill('.cm-content', '')
        session.press_combo.assert_has_calls([call("Control+a"), call("Backspace")])
        session.type_text.assert_not_called()

    def test_wayland_fill_retries_select_all_before_deleting_old_prefix(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, False, True, False])
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "wayland"}), \
                patch("tauri_webdriver.time.monotonic", side_effect=[0, 0.6, 1]):
            session.fill('input[name=title]', 'Taomni')
        session.press_combo.assert_has_calls([call("Mod+a"), call("Mod+a"), call("Backspace")])
        session.type_text.assert_called_once_with("Taomni")
        self.assertIn("selectionEnd === el.value.length", session.execute.call_args_list[1].args[0])

    def test_wayland_fill_rejects_unselected_password_before_modifying_it(self) -> None:
        session = self.session(False)
        session.execute = Mock(return_value=False)
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch.dict(os.environ, {"GDK_BACKEND": "wayland"}), \
                patch("tauri_webdriver.time.monotonic", side_effect=[0, 1, 2, 3, 4, 5]):
            with self.assertRaisesRegex(WebDriverError, "did not select its existing value") as error:
                session.fill('input[type=password]', 'private-secret')
        self.assertNotIn('private-secret', str(error.exception))
        self.assertNotIn(call("Backspace"), session.press_combo.call_args_list)
        self.assertFalse(any(c.args[1].endswith('/value') for c in session.request.call_args_list))
        session.type_text.assert_not_called()

    def test_macos_fill_replaces_value_without_synthetic_backspace(self) -> None:
        session = self.session(False)
        with patch("tauri_webdriver.platform.system", return_value="Darwin"):
            session.fill("input[name=title]", "Taomni")
        session.request.assert_called_once_with(
            "POST", "/session/session-1/element/element-1/value", {"text": "Taomni"})
        session.press_combo.assert_not_called()
        session.type_text.assert_not_called()

    def test_linux_password_fill_retains_exact_shifted_punctuation(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, True, True])
        text = "Qa1_test:@!"
        with patch("tauri_webdriver.platform.system", return_value="Linux"):
            result = session.fill('input[type="password"]', text)
        self.assertEqual(result, 'filled input[type="password"]')
        session.press_combo.assert_has_calls([call("Mod+a"), call("Backspace")])
        session.request.assert_has_calls([
            call("POST", "/session/session-1/element/element-1/click", {}),
            call("POST", "/session/session-1/element/element-1/value", {"text": text}),
        ])
        session.type_text.assert_not_called()
        self.assertIn('el.value === "Qa1_test:@!"', session.execute.call_args.args[0])

    def test_linux_password_fill_fails_before_submit_without_exposing_secret(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, True, False, False])
        text = "Qa1_private:@!"
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch("qa_ui_auto.host_clipboard.get_text", return_value="previous"), \
                patch("qa_ui_auto.host_clipboard.set_text") as set_text, \
                patch("tauri_webdriver.time.monotonic", side_effect=[0, 6]):
            with self.assertRaises(WebDriverError) as error:
                session.fill('input[type="password"]', text)
        self.assertIn("password input did not retain the requested value", str(error.exception))
        self.assertNotIn(text, str(error.exception))
        self.assertEqual(set_text.call_args_list, [call(text), call("previous")])
        session.type_text.assert_not_called()

    def test_linux_password_fill_recovers_unshifted_input_with_real_clipboard_paste(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, True, False, False, True])
        text = "Qa1_private:@!"
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch("qa_ui_auto.host_clipboard.get_text", return_value="QA-LEFT-GUTTER"), \
                patch("qa_ui_auto.host_clipboard.set_text") as set_text, \
                patch("tauri_webdriver.time.sleep") as sleep:
            session.fill('input[type="password"]', text)
        self.assertEqual(set_text.call_args_list, [call(text), call("QA-LEFT-GUTTER")])
        session.press_combo.assert_has_calls([
            call("Mod+a"), call("Backspace"),
            call("Mod+a"), call("Backspace"), call("Control+v"),
        ])
        sleep.assert_called_once_with(0.05)
        session.type_text.assert_not_called()

    def test_linux_password_fill_removes_password_from_clipboard_after_paste_failure(self) -> None:
        session = self.session(False)
        session.execute = Mock(side_effect=[False, True, False])
        session.press_combo.side_effect = ["", "", "", "", WebDriverError("paste failed")]
        text = "Qa1_private:@!"
        with patch("tauri_webdriver.platform.system", return_value="Linux"), \
                patch("qa_ui_auto.host_clipboard.get_text", return_value="previous"), \
                patch("qa_ui_auto.host_clipboard.set_text") as set_text:
            with self.assertRaisesRegex(WebDriverError, "paste failed"):
                session.fill('input[type="password"]', text)
        self.assertEqual(set_text.call_args_list, [call(text), call("previous")])

    def test_windows_password_fill_retains_keyboard_input(self) -> None:
        session = self.session(False)
        with patch("tauri_webdriver.platform.system", return_value="Windows"):
            session.fill('input[type="password"]', "Qa1_test:@!")
        session.type_text.assert_called_once_with("Qa1_test:@!")
        self.assertFalse(any(c.args[1].endswith('/value') for c in session.request.call_args_list))

    def test_type_text_paces_contenteditable_key_transactions(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        with patch("tauri_webdriver.platform.system", return_value="Linux"):
            session.type_text("ab")

        post = next(call for call in session.request.call_args_list if call.args[0] == "POST")
        actions = post.args[2]["actions"][0]["actions"]
        self.assertEqual(
            actions,
            [
                {"type": "keyDown", "value": "a"},
                {"type": "keyUp", "value": "a"},
                {"type": "pause", "duration": 20},
                {"type": "keyDown", "value": "b"},
                {"type": "keyUp", "value": "b"},
                {"type": "pause", "duration": 20},
            ],
        )
        self.assertEqual(session.request.call_args.args, ("DELETE", "/session/session-1/actions"))

    def test_type_text_splits_per_char_on_darwin(self) -> None:
        # The macOS bridge dispatches a whole sequence in one synchronous
        # JS task (coalescing MutationObserver callbacks), so Darwin sends
        # one /actions request per char to preserve event-loop turns.
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        with patch("tauri_webdriver.platform.system", return_value="Darwin"):
            result = session.type_text("ab")

        self.assertEqual(result, "typed 2 chars")
        self.assertEqual(session.request.call_count, 2)
        for call, ch in zip(session.request.call_args_list, "ab"):
            actions = call.args[2]["actions"][0]["actions"]
            self.assertEqual(
                actions,
                [
                    {"type": "keyDown", "value": ch},
                    {"type": "keyUp", "value": ch},
                    {"type": "pause", "duration": 20},
                ],
            )


class NativeSessionPointerClickTest(TestCase):
    def test_pointer_click_uses_viewport_w3c_actions(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.find = Mock(return_value="element-1")
        session.request = Mock(side_effect=[
            {"x": 40, "y": 30, "width": 20, "height": 10},
            None,
        ])

        result = session.pointer_click("#bom")

        self.assertEqual(result, {"x": 50, "y": 35})
        action = session.request.call_args_list[1].args[2]["actions"][0]
        self.assertEqual(action["parameters"], {"pointerType": "mouse"})
        self.assertEqual(action["id"], "mouse")
        self.assertEqual(action["actions"][0], {
            "type": "pointerMove",
            "duration": 100,
            "x": 50,
            "y": 35,
            "origin": "viewport",
        })
        self.assertEqual(action["actions"][1]["type"], "pointerDown")
        self.assertEqual(action["actions"][-1]["type"], "pointerUp")

    def test_pointer_drag_holds_modifier_across_viewport_drag(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        result = session.pointer_drag(
            {"x": 30, "y": 40},
            {"x": 80, "y": 90},
            ["Alt"],
        )

        self.assertEqual(result, {
            "start": {"x": 30, "y": 40},
            "end": {"x": 80, "y": 90},
        })
        payload = session.request.call_args_list[0].args[2]
        keyboard, pointer = payload["actions"]
        self.assertEqual(keyboard["actions"][0], {"type": "keyDown", "value": "\ue00a"})
        self.assertEqual(keyboard["actions"][-1], {"type": "keyUp", "value": "\ue00a"})
        self.assertEqual(pointer["parameters"], {"pointerType": "mouse"})
        self.assertEqual(pointer["id"], "mouse")
        self.assertEqual(pointer["actions"][1]["x"], 30)
        self.assertEqual(pointer["actions"][3]["x"], 80)
        self.assertEqual(pointer["actions"][2]["type"], "pointerDown")
        self.assertEqual(pointer["actions"][5]["type"], "pointerUp")
        self.assertEqual(session.request.call_args_list[1].args[:2], (
            "DELETE", session.endpoint("/actions"),
        ))


class NativeSessionPressComboTest(TestCase):
    def test_press_combo_releases_webdriver_input_sources(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        session.press_combo("Control+v")

        payload = session.request.call_args_list[0].args[2]
        actions = payload["actions"][0]["actions"]
        self.assertEqual(actions[0], {"type": "keyDown", "value": "\ue009"})
        key_actions = [action for action in actions if action["type"] != "pause"]
        self.assertEqual(key_actions[-1], {"type": "keyUp", "value": "\ue009"})
        self.assertEqual(session.request.call_args_list[1].args[:2], (
            "DELETE", session.endpoint("/actions"),
        ))

    def test_capitalized_shortcut_letter_does_not_add_an_implicit_shift(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))

        self.assertEqual(
            session._combo_actions("Control+Alt+M"),
            [
                {"type": "keyDown", "value": session.MODIFIER_MAP["Control"]},
                {"type": "keyDown", "value": session.MODIFIER_MAP["Alt"]},
                {"type": "keyDown", "value": "m"},
                {"type": "pause", "duration": 30},
                {"type": "keyUp", "value": "m"},
                {"type": "keyUp", "value": session.MODIFIER_MAP["Alt"]},
                {"type": "keyUp", "value": session.MODIFIER_MAP["Control"]},
                {"type": "pause", "duration": 30},
            ],
        )


class NativeKeysVerbTest(TestCase):
    def test_x11_chord_maps_modifiers_before_the_character(self) -> None:
        self.assertEqual(
            native_steps._x11_keysyms_for_chord("Control+Shift+v"),
            [0xFFE3, 0xFFE1, ord("v")],
        )

    def test_native_keys_requires_focus_and_records_x11_transport(self) -> None:
        session = Mock()
        session.execute.return_value = True

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ) as activate,
                patch.object(native_steps, "_inject_x11_keys") as inject,
            ):
                result = native_steps.VERBS["native_keys"](
                    ctx,
                    {"selector": "#encoding", "keys": ["Tab", "Control+v"]},
                )

            self.assertIn("injected 2", result)
            activate.assert_called_once_with(session.application)
            inject.assert_called_once_with(["Tab", "Control+v"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["transport"], "X11 XTest -> GTK/WebKitGTK")
            self.assertEqual(artifact["keys"], ["Tab", "Control+v"])
            self.assertNotIn("text", artifact)

    def test_native_keys_can_focus_target_before_verifying_ownership(self) -> None:
        session = Mock()
        session.execute.side_effect = [True, None, []]

        with TemporaryDirectory() as directory, patch.object(native_steps.time, "sleep"):
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            native_steps.VERBS["native_keys"](ctx, {
                "selector": ".cm-content",
                "keys": ["Control+z"],
                "transport": "webdriver",
                "focus_target": True,
            })

            session.focus.assert_called_once_with(".cm-content")
            session.press_combos.assert_called_once_with(["Control+z"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                artifact["focus_verification"],
                "WebDriver focus then immediate DOM probe",
            )

    def test_native_keys_accepts_explicit_focus_precondition_during_driver_fault(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ),
                patch.object(native_steps, "_inject_x11_keys") as inject,
            ):
                native_steps.VERBS["native_keys"](
                    ctx,
                    {
                        "selector": ".cm-content",
                        "keys": ["Control+v"],
                        "focus_prechecked": True,
                    },
                )

            session.execute.assert_not_called()
            inject.assert_called_once_with(["Control+v"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["focus_verification"], "testcase precondition")

    def test_native_keys_waits_for_readiness_and_requires_consumed_keydown(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.find.return_value = "popup"
        session.execute.side_effect = [
            True,
            None,
            True,
            True,
            {"stable": True, "stableMs": 200},
            [{"type": "keydown", "key": "ArrowDown", "defaultPrevented": True}],
        ]

        def press(keys: list[str]) -> None:
            self.assertEqual(session.execute.call_count, 5)
            self.assertEqual(keys, ["ArrowDown"])

        session.press_combos.side_effect = press
        with TemporaryDirectory() as directory, patch.object(native_steps.time, "sleep"):
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            result = native_steps.VERBS["native_keys"](ctx, {
                "selector": ".cm-content",
                "keys": ["ArrowDown"],
                "transport": "webdriver",
                "ready_selector": ".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)",
                "ready_timeout_sec": 3,
                "ready_stable_sec": 0.2,
                "require_keydown_prevented": True,
            })

            self.assertIn("injected 1", result)
            listener_script = session.execute.call_args_list[1].args[0]
            self.assertIn("setTimeout", listener_script)
            session.find.assert_called_with(
                ".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)",
                timeout=0.5,
            )
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertTrue(artifact["require_keydown_prevented"])
            self.assertEqual(
                artifact["ready_selector"],
                ".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)",
            )
            self.assertEqual(artifact["ready_stable_sec"], 0.2)

    def test_native_keys_rejects_unconsumed_keydown_after_recording_evidence(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.execute.side_effect = [
            True,
            None,
            [{"type": "keydown", "key": "ArrowDown", "defaultPrevented": False}],
        ]
        with TemporaryDirectory() as directory, patch.object(native_steps.time, "sleep"):
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with self.assertRaisesRegex(
                native_steps.StepError,
                "keydown was not consumed.*arrowdown",
            ):
                native_steps.VERBS["native_keys"](ctx, {
                    "selector": ".cm-content",
                    "keys": ["ArrowDown"],
                    "transport": "webdriver",
                    "require_keydown_prevented": True,
                })
            self.assertTrue((case_dir / "native-key-observation.json").is_file())


class NativeClickVerbTest(TestCase):
    def test_native_click_targets_exact_window_and_records_pointer_transport(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.execute.side_effect = [
            {
                "x": 100,
                "y": 50,
                "width": 20,
                "height": 10,
                "innerWidth": 600,
                "innerHeight": 400,
                "disabled": False,
            },
            {"activeTestId": "file-encoding-bom", "checked": True},
        ]
        session.pointer_click.return_value = {"x": 110, "y": 55}

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ) as activate,
            ):
                result = native_steps.VERBS["native_click"](
                    ctx,
                    {"selector": '[data-testid="file-encoding-bom"]'},
                )

            self.assertEqual(
                result,
                'injected native WebKitGTK pointer click into [data-testid="file-encoding-bom"]',
            )
            activate.assert_called_once_with(session.application)
            session.pointer_click.assert_called_once_with('[data-testid="file-encoding-bom"]')
            artifact = json.loads(
                (case_dir / "native-pointer-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                artifact["transport"],
                "W3C pointer actions -> packaged WebKitGTK session",
            )
            self.assertEqual(artifact["postcondition"]["checked"], True)
            self.assertNotIn("text", artifact)


class NativePointerDragVerbTest(TestCase):
    def test_native_pointer_drag_resolves_geometry_and_records_no_source_text(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.execute.side_effect = [
            {
                "start": {"x": 110, "y": 60, "lineLength": 9},
                "end": {"x": 140, "y": 80, "lineLength": 8},
                "lineCount": 2,
                "innerWidth": 600,
                "innerHeight": 400,
            },
            {"focused": True, "selectionRectCount": 2, "cursorCount": 2},
        ]
        session.pointer_drag.return_value = {
            "start": {"x": 110, "y": 60},
            "end": {"x": 140, "y": 80},
        }

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ),
            ):
                result = native_steps.VERBS["native_pointer_drag"](
                    ctx,
                    {
                        "selector": ".cm-content",
                        "from": {"line": 1, "column": 1},
                        "to": {"line": 2, "column": 4},
                        "modifiers": ["Alt"],
                    },
                )

            self.assertIn("line 1 column 1", result)
            session.pointer_drag.assert_called_once_with(
                {"x": 110, "y": 60, "lineLength": 9},
                {"x": 140, "y": 80, "lineLength": 8},
                ["Alt"],
            )
            artifact = json.loads(
                (case_dir / "native-pointer-drag-observation.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(artifact["postcondition"]["selectionRectCount"], 2)
            self.assertEqual(artifact["requested"]["modifiers"], ["Alt"])
            self.assertNotIn("alpha", json.dumps(artifact))


class NativeFilesystemFaultTest(TestCase):
    @skipUnless(sys.platform.startswith("linux"), "requires real Linux chmod semantics")
    def test_native_set_writable_is_report_scoped_and_records_modes(self) -> None:
        with TemporaryDirectory() as directory:
            report_root = Path(directory)
            case_dir = report_root / "TC-NATIVE"
            case_dir.mkdir()
            target = report_root / "native-workspaces" / "fixture"
            target.mkdir(parents=True, mode=0o700)
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})

            blocked = native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": False},
            )
            self.assertIn("writable=False", blocked)
            self.assertFalse(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)

            ctx.restore_host_permissions()
            self.assertTrue(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)

            native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": False},
            )
            restored = native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": True},
            )
            self.assertIn("writable=True", restored)
            self.assertTrue(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)
            observations = json.loads(
                (case_dir / "native-permission-observations.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                [row["ownerWritable"] for row in observations],
                [False, False, True],
            )

    def test_assert_file_sha256_reads_real_host_bytes(self) -> None:
        with TemporaryDirectory() as directory:
            report_root = Path(directory)
            case_dir = report_root / "TC-NATIVE"
            case_dir.mkdir()
            target = report_root / "native-workspaces" / "fixture.txt"
            target.parent.mkdir()
            target.write_bytes(b"receipt bytes")
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})

            result = native_steps.VERBS["assert_file_sha256"](
                ctx,
                {
                    "path": str(target),
                    "equals": "9e85aa95f04db5f108534e48b63e75e8045a7ecab59988405e70a9260300a0d6",
                },
            )
            self.assertIn("host byte SHA-256 verified", result)


class NativeClipboardOwnerTest(TestCase):
    """Real X11 CLIPBOARD selection verbs (ED-CLIP-004).

    These exercise the actual selection transfer between two separate
    processes; they skip rather than fake it when no X11 display exists,
    because a stubbed clipboard would prove nothing about the OS boundary.
    """

    def setUp(self) -> None:
        if os.name != "posix" or not os.environ.get("DISPLAY"):
            self.skipTest("requires a Linux X11 display")

    def test_grant_suspend_resume_crosses_the_real_x11_boundary(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            try:
                granted = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "grant", "text": "qa-clipboard-owner-payload"}
                )
                self.assertIn("holds CLIPBOARD", granted)

                # An independent process reads the exact granted value.
                equal = native_steps.VERBS["assert_system_clipboard"](
                    ctx, {"equals": "qa-clipboard-owner-payload"}
                )
                self.assertIn("assertion passed", equal)

                # Suspending the owner denies every client's read.
                suspended = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "suspend"}
                )
                self.assertIn("external X11 read denied", suspended)
                self.assertIn(
                    "readable=False",
                    native_steps.VERBS["assert_system_clipboard"](ctx, {"readable": False}),
                )
                with self.assertRaises(native_steps.StepError):
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"equals": "qa-clipboard-owner-payload"}
                    )

                resumed = native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "resume"})
                self.assertIn("external X11 read restored", resumed)
                self.assertIn(
                    "assertion passed",
                    native_steps.VERBS["assert_system_clipboard"](ctx, {"readable": True}),
                )
            finally:
                ctx.restore_host_permissions()

            observations = json.loads(
                (case_dir / "native-clipboard-observations.json").read_text(encoding="utf-8")
            )
            # The `equals` assertion that correctly raised under denial records
            # nothing: an observation is appended only for a passing assertion.
            self.assertEqual(
                [row["action"] for row in observations],
                ["grant", "assert", "suspend", "assert", "resume", "assert"],
            )
            denied = [row for row in observations if row["action"] == "suspend"][0]
            self.assertFalse(denied["externalReadOk"])
            self.assertIn(denied["ownerProcState"], {"T", "t"})

    def test_grant_deny_resume_crosses_the_real_x11_boundary(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            try:
                native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "grant", "text": "qa-clipboard-deny-payload"}
                )
                granted_owner = ctx._clipboard_owner

                denied = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "deny"}
                )
                self.assertIn("denies X11 text conversion", denied)
                self.assertIsNotNone(granted_owner.poll())
                self.assertEqual(ctx._clipboard_owner_mode, "deny")
                self.assertIn(
                    "readable=False",
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"readable": False, "timeout_sec": 5}
                    ),
                )

                denying_owner = ctx._clipboard_owner
                resumed = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "resume"}
                )
                self.assertIn("external X11 read restored", resumed)
                self.assertIsNotNone(denying_owner.poll())
                self.assertEqual(ctx._clipboard_owner_mode, "grant")
                self.assertIn(
                    "assertion passed",
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"equals": "qa-clipboard-deny-payload"}
                    ),
                )
            finally:
                ctx.restore_host_permissions()

            observations = json.loads(
                (case_dir / "native-clipboard-observations.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                [row["action"] for row in observations],
                ["grant", "deny", "assert", "resume", "assert"],
            )
            denied = [row for row in observations if row["action"] == "deny"][0]
            self.assertFalse(denied["externalReadOk"])
            self.assertEqual(denied["ownerMode"], "text-targets-reject-conversion")
            resumed = [row for row in observations if row["action"] == "resume"][0]
            self.assertEqual(resumed["resumeMode"], "replaced-denying-owner")

    def test_teardown_releases_the_owner_process(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            native_steps.VERBS["native_clipboard_owner"](
                ctx, {"action": "grant", "text": "qa-clipboard-teardown"}
            )
            owner = ctx._clipboard_owner
            self.assertIsNotNone(owner)
            native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "suspend"})
            ctx.restore_host_permissions()
            self.assertIsNone(ctx._clipboard_owner)
            self.assertIsNotNone(owner.poll())

    def test_teardown_does_not_republish_its_own_payload_as_host_state(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            native_steps.VERBS["native_clipboard_owner"](
                ctx, {"action": "grant", "text": "qa-clipboard-not-host-state"}
            )
            ctx.restore_host_permissions()

            # A LATER case snapshotting what an earlier case granted must not
            # treat it as host state: the guard is process-wide, so one case
            # cannot republish another case's payload as a restore.
            later = native_steps.NativeStepContext(Mock(), case_dir, {})
            later._host_clipboard_before = "qa-clipboard-not-host-state"
            later._host_clipboard_captured = True
            with patch.object(native_steps, "_spawn_clipboard_owner") as spawn:
                later.restore_host_permissions()
            spawn.assert_not_called()

            # Teardown discloses the replacement instead of faking a restore.
            host_state = json.loads(
                (case_dir / "native-clipboard-host-state.json").read_text(encoding="utf-8")
            )
            self.assertTrue(host_state["hostSelectionReplaced"])
            self.assertFalse(host_state["hostSelectionRestored"])
            self.assertTrue(host_state["priorSelectionWasHarnessPayload"])

    def test_suspend_without_grant_fails_loudly(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "suspend"})

    def test_assert_system_clipboard_rejects_ambiguous_assertions(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["assert_system_clipboard"](
                    ctx, {"equals": "a", "readable": True}
                )
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["assert_system_clipboard"](ctx, {})


class MacosDebuggerProcessTest(TestCase):
    def test_opt_in_debugger_keeps_the_isolated_application_and_captures_all_threads(self):
        with TemporaryDirectory() as root, patch("tauri_webdriver.platform.system", return_value="Darwin"), \
                patch("tauri_webdriver._tcp_ok", side_effect=[False, True]), \
                patch("tauri_webdriver.subprocess.Popen") as launch:
            app = Path(root) / "qa-app"
            app.touch()
            launch.return_value.poll.return_value = None
            driver = TauriDriverProcess({"app": {"native_binary": str(app), "macos_lldb": True}}, Path(root))
            driver.start()
            command = launch.call_args.args[0]
            self.assertEqual(command[0], "lldb")
            self.assertEqual(command[-2:], ["--", str(app.resolve())])
            self.assertIn("thread backtrace all", command)
            self.assertTrue(launch.call_args.kwargs["start_new_session"])
            self.assertEqual(launch.call_args.kwargs["env"]["TAOMNI_QA_WEBDRIVER_PORT"], "4444")

    def test_debugger_cleanup_reaps_only_owned_descendants_before_the_debugger(self):
        with TemporaryDirectory() as root, patch("tauri_webdriver.platform.system", return_value="Darwin"), \
                patch("tauri_webdriver.subprocess.check_output", return_value="4321 1\n5000 4321\n5001 5000\n6000 1\n6001 6000\n"), \
                patch("tauri_webdriver.os.kill") as kill:
            driver = TauriDriverProcess({"app": {"macos_lldb": True}}, Path(root))
            process = Mock(pid=4321)
            process.poll.return_value = None
            driver.proc = process
            driver.stop()
            self.assertEqual([call.args[0] for call in kill.call_args_list], [5001, 5000])
            process.terminate.assert_called_once_with()
            process.wait.assert_called_once_with(timeout=5)
            self.assertIsNone(driver.proc)

    def test_unresponsive_live_debugger_uses_owned_tree_cleanup_before_restart(self):
        with TemporaryDirectory() as root, patch("tauri_webdriver.platform.system", return_value="Darwin"), \
                patch("tauri_webdriver._tcp_ok", return_value=False):
            driver = TauriDriverProcess({"app": {"macos_lldb": True}}, Path(root))
            driver.proc = Mock()
            driver.proc.poll.return_value = None
            driver.stop = Mock()
            driver.start = Mock()
            driver.ensure_running()
            driver.stop.assert_called_once_with()
            driver.start.assert_called_once_with()

    @skipUnless(os.name == "posix", "requires a POSIX debugger process tree")
    def test_cleanup_releases_a_real_inferior_port_in_a_separate_process_group(self):
        child_code = ("import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); "
                      "s.listen(); print(s.getsockname()[1],flush=True); time.sleep(30)")
        parent_code = ("import subprocess,sys; "
                       f"p=subprocess.Popen([sys.executable,'-c',{child_code!r}], "
                       "stdout=subprocess.PIPE,text=True,start_new_session=True); "
                       "print(p.stdout.readline().strip(),flush=True); p.wait()")
        process = subprocess.Popen([sys.executable, "-c", parent_code], stdout=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            port = int(process.stdout.readline())
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                pass
            with TemporaryDirectory() as root, patch("tauri_webdriver.platform.system", return_value="Darwin"):
                driver = TauriDriverProcess({"app": {"macos_lldb": True}}, Path(root))
                driver.proc = process
                driver.stop()
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=2)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
