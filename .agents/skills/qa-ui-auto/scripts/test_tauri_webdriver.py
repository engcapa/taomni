import json
import os
from pathlib import Path
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory
from unittest import TestCase, skipUnless
from unittest.mock import Mock, call, patch

from qa_ui_auto import native_steps
from tauri_webdriver import NativeHarness, NativeSession, WebDriverError, selector_strategy


class NativeSessionTransportTest(TestCase):
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
        session.install_console_hook = Mock()
        with patch("tauri_webdriver.platform.system", return_value="Windows"), \
             patch.dict(os.environ, {"NEWMOB_DATA_DIR": "/qa/run/native-appdata"}):
            session.start()
        options = session.request.call_args.args[2]["capabilities"]["alwaysMatch"]["tauri:options"]
        self.assertEqual(options["webviewOptions"]["userDataFolder"],
                         str(Path("/qa/run/native-appdata/com.taomni.app.qa/webview")))

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

    def test_count_accepts_empty_but_rejects_invalid_driver_response(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.request = Mock(side_effect=[[], {"error": "bad response"}])
        self.assertEqual(session.count(".tab"), 0)
        with self.assertRaisesRegex(Exception, "invalid element list"):
            session.count(".tab")

    def test_scoped_press_focuses_without_activation(self):
        session = NativeSession("http://driver.invalid", Path("unused"))
        session.session_id = "session-1"
        session.find = Mock(return_value="row-1")
        session.request = Mock(return_value=True)
        session.press_combo = Mock(return_value="pressed")
        ctx = Mock(session=session)
        native_steps._press(ctx, {"selector": "#folder", "key": "ArrowRight"})
        session.press_combo.assert_called_once_with("ArrowRight")
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

    def test_macos_session_waits_for_react_root_before_installing_hooks(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.request = Mock(return_value={"sessionId": "session-1"})
        session.execute = Mock(side_effect=[WebDriverError("WebView is still loading"), False, True])
        session.install_console_hook = Mock()

        with patch("tauri_webdriver.platform.system", return_value="Darwin"):
            session.start()

        self.assertEqual(session.session_id, "session-1")
        self.assertEqual(session.execute.call_count, 3)
        self.assertIn("document.readyState", session.execute.call_args_list[0].args[0])
        session.install_console_hook.assert_called_once_with()


class NativeSessionFillTest(TestCase):
    def session(self, contenteditable: bool, focus_results: list[bool] | None = None) -> NativeSession:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.find = Mock(return_value="element-1")
        session.request = Mock(return_value=None)
        execute_results: list[bool] = [contenteditable]
        if contenteditable:
            execute_results.extend(focus_results or [True])
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

    def test_macos_fill_replaces_value_without_synthetic_backspace(self) -> None:
        session = self.session(False)
        with patch("tauri_webdriver.platform.system", return_value="Darwin"):
            session.fill("input[name=title]", "Taomni")
        session.request.assert_called_once_with(
            "POST", "/session/session-1/element/element-1/value", {"text": "Taomni"})
        session.press_combo.assert_not_called()
        session.type_text.assert_not_called()

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
                'injected X11 pointer click into [data-testid="file-encoding-bom"]',
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
