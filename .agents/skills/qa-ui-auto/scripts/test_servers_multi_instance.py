"""Unit tests for Local servers multi-instance probe and NativeHarness shared-data overrides."""
from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import tauri_webdriver as native
from qa_ui_auto import behavior_contract, servers_multi_instance
from qa_ui_auto.steps import StepContext, StepError, get as get_browser_verb
from qa_ui_auto.native_steps import NativeStepContext, VERBS as NATIVE_VERBS
from qa_ui_auto.testcase import validate_doc


class _FakeLocator:
    def __init__(self, page: "_FakePage", selector: str):
        self.page = page
        self.selector = selector

    @property
    def first(self) -> "_FakeLocator":
        return self

    def count(self) -> int:
        return self.page.counts.get(self.selector, 0)

    def is_visible(self) -> bool:
        return self.count() > 0

    def wait_for(self, *, state: str = "visible", timeout: int = 10_000) -> None:
        self.page.waits.append((self.selector, state))

    def text_content(self) -> str:
        return self.page.texts.get(self.selector, "")

    def click(self) -> None:
        self.page.on_click(self.selector)


class _FakePage:
    def __init__(self, name: str, handlers: dict[str, object], context: object = None):
        self.name = name
        self._handlers = handlers
        self.context = context
        self.counts: dict[str, int] = {}
        self.texts: dict[str, str] = {}
        self.waits: list[tuple[str, str]] = []
        self.events: list[tuple[str, object]] = []
        self.listeners: dict[str, list] = {}
        self.closed = False

    def on(self, event: str, fn) -> None:
        self.listeners.setdefault(event, []).append(fn)

    def remove_listener(self, event: str, fn) -> None:
        if event in self.listeners and fn in self.listeners[event]:
            self.listeners[event].remove(fn)

    def goto(self, url: str, **_kwargs) -> None:
        self.events.append(("goto", url))

    def locator(self, selector: str) -> _FakeLocator:
        return _FakeLocator(self, selector)

    def evaluate(self, _script: str) -> dict:
        return {"crash": None}

    def on_click(self, selector: str) -> None:
        self.events.append(("click", selector))
        callback = self._handlers.get(selector)
        if callable(callback):
            callback(self)

    def is_closed(self) -> bool:
        return self.closed

    def close(self, *, run_before_unload: bool = False) -> None:
        self.closed = True
        self.events.append(("close", run_before_unload))
        callback = self._handlers.get("close")
        if callable(callback):
            callback(self, run_before_unload)


class ServersMultiInstanceTest(unittest.TestCase):
    def test_build_peer_shared_data_env_per_platform(self):
        with TemporaryDirectory() as directory:
            peer = Path(directory) / "peer"
            linux = servers_multi_instance.build_peer_shared_data_env(
                {"XDG_DATA_HOME": "/qa/primary/data"},
                peer,
                system="Linux",
            )
            self.assertEqual(linux["XDG_DATA_HOME"], "/qa/primary/data")
            self.assertEqual(linux["TAOMNI_QA_WEBVIEW_DIR"], str((peer / "native-webview").resolve()))

            windows = servers_multi_instance.build_peer_shared_data_env(
                {"NEWMOB_DATA_DIR": "C:\\qa\\data", "APPDATA": "C:\\qa\\data"},
                peer,
                system="Windows",
            )
            self.assertEqual(windows["NEWMOB_DATA_DIR"], "C:\\qa\\data")
            self.assertEqual(windows["APPDATA"], "C:\\qa\\data")
            self.assertEqual(windows["TAOMNI_QA_WEBVIEW_DIR"], str((peer / "native-webview").resolve()))

            darwin = servers_multi_instance.build_peer_shared_data_env(
                {"NEWMOB_DATA_DIR": "/qa/mac/data"},
                peer,
                system="Darwin",
            )
            self.assertEqual(darwin["NEWMOB_DATA_DIR"], "/qa/mac/data")

            with self.assertRaises(StepError):
                servers_multi_instance.build_peer_shared_data_env({}, peer, system="Linux")

    def test_windows_session_uses_qa_webview_dir_override(self):
        with patch.object(native.platform, "system", return_value="Windows"), \
             patch.dict(
                 os.environ,
                 {
                     "NEWMOB_DATA_DIR": "C:\\qa\\primary",
                     "TAOMNI_QA_WEBVIEW_DIR": "C:\\qa\\peer\\native-webview",
                 },
             ):
            session = native.NativeSession("http://127.0.0.1:4444", Path("taomni.exe"))
            session.request = Mock(return_value={"sessionId": "sid-1"})
            session.wait_for_app_ready = Mock()
            session.activate_linux_window = Mock()
            session.install_console_hook = Mock()
            session.start()
        payload = session.request.call_args.args[2]
        opts = payload["capabilities"]["alwaysMatch"]["tauri:options"]["webviewOptions"]
        self.assertEqual(opts["userDataFolder"], "C:\\qa\\peer\\native-webview")

    def test_native_harness_merges_and_restores_shared_data_env(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "taomni"
            binary.write_bytes(b"fake")
            harness = native.NativeHarness(
                {"app": {"native_binary": str(binary)}},
                root / "peer",
                shared_data_env={
                    "XDG_DATA_HOME": "/qa/shared/data",
                    "TAOMNI_QA_WEBVIEW_DIR": str(root / "peer" / "native-webview"),
                },
            )
            harness.driver = SimpleNamespace(start=Mock(), stop=Mock(), macos_lldb=False)
            before = os.environ.get("TAOMNI_QA_WEBVIEW_DIR")
            with (
                patch.object(
                    native,
                    "verify_identity",
                    return_value={"identifier": "com.taomni.app.qa", "binary_sha256": "abc123"},
                ),
                patch.object(native.platform, "system", return_value="Linux"),
            ):
                with harness:
                    self.assertEqual(os.environ["XDG_DATA_HOME"], "/qa/shared/data")
                    self.assertEqual(
                        os.environ["TAOMNI_QA_WEBVIEW_DIR"],
                        str(root / "peer" / "native-webview"),
                    )
            self.assertEqual(os.environ.get("TAOMNI_QA_WEBVIEW_DIR"), before)

    def test_dry_run_and_schema_contract_registration(self):
        self.assertTrue(behavior_contract.is_check({"servers_multi_instance_probe": {}}))
        doc = {
            "id": "TC-SERVERS-SAMPLE",
            "title": "Sample validation",
            "description": "Validates servers_multi_instance_probe schema registration.",
            "modes": ["browser", "native"],
            "covers": ["F-Servers-1"],
            "steps": [{"servers_multi_instance_probe": {}}],
        }
        self.assertEqual(validate_doc(doc, source="sample"), [])

        browser_ctx = StepContext(
            page=None,
            case_id="TC-SERVERS-SAMPLE",
            case_dir=Path("/tmp"),
            cfg={},
            env={},
            dry_run=True,
        )
        get_browser_verb("servers_multi_instance_probe")(browser_ctx, {})

        native_ctx = SimpleNamespace(session=None, case_dir=Path("/tmp"), cfg={}, dry_run=True)
        NATIVE_VERBS["servers_multi_instance_probe"](native_ctx, {})

    def test_browser_run_exercises_block_handover_and_unload_recovery(self):
        state = {"holder": "primary"}

        def open_servers_for(who: str, page: _FakePage) -> None:
            if state["holder"] and state["holder"] != who:
                page.counts[servers_multi_instance.BLOCKED_DIALOG] = 1
                page.texts[servers_multi_instance.BLOCKED_MESSAGE] = "Held by primary"
                return
            state["holder"] = who
            page.counts[servers_multi_instance.SERVERS_TAB] = 1
            page.counts[servers_multi_instance.SERVERS_PANEL] = 1
            page.counts[servers_multi_instance.SERVERS_DIALOG] = 1
            page.counts[servers_multi_instance.BLOCKED_DIALOG] = 0

        def make_handlers(who: str) -> dict[str, object]:
            return {
                servers_multi_instance.SIDE_TAB_TOOLS: lambda p: p.counts.__setitem__(
                    servers_multi_instance.SIDEBAR_TOOL_SERVERS, 1
                ),
                servers_multi_instance.SIDEBAR_TOOL_SERVERS: lambda p: open_servers_for(who, p),
                servers_multi_instance.BLOCKED_OK: lambda p: p.counts.__setitem__(
                    servers_multi_instance.BLOCKED_DIALOG, 0
                ),
                servers_multi_instance.SERVERS_TAB_CLOSE: lambda p: (
                    p.counts.update(
                        {
                            servers_multi_instance.SERVERS_TAB: 0,
                            servers_multi_instance.SERVERS_PANEL: 0,
                            servers_multi_instance.SERVERS_DIALOG: 0,
                        }
                    ),
                    state.update({"holder": None}) if state["holder"] == who else None,
                ),
                "close": lambda _p, run_unload: state.update({"holder": None})
                if run_unload and state["holder"] == who
                else None,
            }

        peer = _FakePage("peer", make_handlers("peer"))
        peer.counts[servers_multi_instance.WELCOME_PANEL] = 1
        primary = _FakePage("primary", make_handlers("primary"), context=SimpleNamespace(new_page=lambda: peer))
        primary.counts[servers_multi_instance.SERVERS_TAB] = 1
        primary.counts[servers_multi_instance.SERVERS_PANEL] = 1
        primary.counts[servers_multi_instance.SERVERS_DIALOG] = 1
        primary.counts[servers_multi_instance.SIDEBAR_TOOL_SERVERS] = 1

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = StepContext(
                page=primary,
                case_id="TC-SERVERS-001",
                cfg={"app": {"base_url": "http://127.0.0.1:5000"}},
                case_dir=case_dir,
                env={},
                dry_run=False,
            )
            summary = servers_multi_instance.browser_run(ctx, {})
            self.assertIn("browser", summary)
            evidence = json.loads((case_dir / "servers-multi-instance.json").read_text(encoding="utf-8"))
            self.assertEqual(evidence["mode"], "browser")
            self.assertEqual(evidence["blockedMessage"], "Held by primary")
            self.assertIn(("close", True), peer.events)

    def test_native_run_exercises_shared_lock_and_process_termination_recovery(self):
        state = {"holder": "primary"}

        class _FakeNativeSession:
            def __init__(self, who: str):
                self.who = who
                self.counts = {
                    servers_multi_instance.WELCOME_PANEL: 1,
                    servers_multi_instance.SERVERS_TAB: 1 if who == "primary" else 0,
                    servers_multi_instance.SERVERS_PANEL: 1 if who == "primary" else 0,
                    servers_multi_instance.SERVERS_DIALOG: 1 if who == "primary" else 0,
                    servers_multi_instance.SIDEBAR_TOOL_SERVERS: 1 if who == "primary" else 0,
                    servers_multi_instance.BLOCKED_DIALOG: 0,
                }
                self.texts = {servers_multi_instance.BLOCKED_MESSAGE: ""}

            def text(self, selector: str) -> str:
                return self.texts.get(selector, "")

            def find(self, selector: str, timeout: float = 10.0) -> dict:
                if self.counts.get(selector, 0) <= 0:
                    raise AssertionError(f"missing {selector} on {self.who}")
                return {"element": selector}

            def click(self, selector: str) -> str:
                if selector == servers_multi_instance.SIDE_TAB_TOOLS:
                    self.counts[servers_multi_instance.SIDEBAR_TOOL_SERVERS] = 1
                elif selector == servers_multi_instance.SIDEBAR_TOOL_SERVERS:
                    if state["holder"] and state["holder"] != self.who:
                        self.counts[servers_multi_instance.BLOCKED_DIALOG] = 1
                        self.texts[servers_multi_instance.BLOCKED_MESSAGE] = "Locked by PID 1234"
                    else:
                        state["holder"] = self.who
                        self.counts[servers_multi_instance.SERVERS_TAB] = 1
                        self.counts[servers_multi_instance.SERVERS_PANEL] = 1
                        self.counts[servers_multi_instance.SERVERS_DIALOG] = 1
                        self.counts[servers_multi_instance.BLOCKED_DIALOG] = 0
                elif selector == servers_multi_instance.BLOCKED_OK:
                    self.counts[servers_multi_instance.BLOCKED_DIALOG] = 0
                elif selector == servers_multi_instance.SERVERS_TAB_CLOSE:
                    self.counts[servers_multi_instance.SERVERS_TAB] = 0
                    self.counts[servers_multi_instance.SERVERS_PANEL] = 0
                    self.counts[servers_multi_instance.SERVERS_DIALOG] = 0
                    if state["holder"] == self.who:
                        state["holder"] = None
                return "ok"

            def execute(self, script: str):
                if "__QA_UI_AUTO_CONSOLE__" in script:
                    return {
                        "installed": True,
                        "entries": [],
                        "focusHistory": [],
                        "resizeObservers": None,
                        "crash": None,
                    }
                if "getBoundingClientRect" in script and "const el =" not in script:
                    return self.counts.get(servers_multi_instance.SIDEBAR_TOOL_SERVERS, 0) > 0
                if "const el =" in script:
                    for selector, count in self.counts.items():
                        key = selector.split('"')[1]
                        if key in script:
                            return count > 0
                    return False
                for selector, count in self.counts.items():
                    if json.dumps(selector) in script:
                        if "&&" in script:
                            return (
                                self.counts[servers_multi_instance.SERVERS_TAB] == 0
                                and self.counts[servers_multi_instance.SERVERS_DIALOG] == 0
                            )
                        if "=== 0" in script:
                            return count == 0
                        return count
                raise AssertionError(f"unexpected script: {script}")

            def close(self) -> None:
                if state["holder"] == self.who:
                    state["holder"] = None

        primary_session = _FakeNativeSession("primary")
        peer_session = _FakeNativeSession("peer")
        captured_harness_kwargs: dict[str, object] = {}

        class _FakeHarness:
            def __init__(self, cfg, root, *, shared_data_env=None):
                captured_harness_kwargs["cfg"] = cfg
                captured_harness_kwargs["root"] = root
                captured_harness_kwargs["shared_data_env"] = shared_data_env

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                peer_session.close()

            def create_session(self):
                return peer_session

        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "case"
            case_dir.mkdir()
            ctx = NativeStepContext(
                session=primary_session,
                case_dir=case_dir,
                cfg={"app": {"native_binary": "/tmp/taomni"}, "webdriver": {"port": 4444, "native_port": 4445}},
            )
            with (
                patch.dict(os.environ, {"XDG_DATA_HOME": "/qa/primary/data"}),
                patch.object(servers_multi_instance.platform, "system", return_value="Linux"),
                patch.object(servers_multi_instance, "free_ports", return_value=(4550, 4551)),
                patch("tauri_webdriver.NativeHarness", _FakeHarness),
            ):
                summary = servers_multi_instance.native_run(ctx, {})
            self.assertIn("native two-process", summary)
            self.assertEqual(
                captured_harness_kwargs["shared_data_env"]["XDG_DATA_HOME"],
                "/qa/primary/data",
            )
            self.assertEqual(captured_harness_kwargs["cfg"]["webdriver"]["port"], 4550)
            self.assertEqual(captured_harness_kwargs["cfg"]["webdriver"]["native_port"], 4551)
            evidence = json.loads((case_dir / "servers-multi-instance.json").read_text(encoding="utf-8"))
            self.assertEqual(evidence["mode"], "native")
            self.assertEqual(evidence["blockedMessage"], "Locked by PID 1234")


if __name__ == "__main__":
    unittest.main()
