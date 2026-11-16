"""Application IPC rejections remain data through the native W3C transport."""
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

from native_webdriver_transport import WebDriverError
from qa_ui_auto.module_signed_observation import check, invoke
from tauri_webdriver import NativeSession


class ModuleSignedObservationTests(unittest.TestCase):
    def session_with_ipc_result(self, result):
        session = NativeSession("http://unit.invalid", Path("unused"))
        session.session_id = "unit-session"
        scripts = []

        def response(request, **_kwargs):
            script = json.loads(request.data)["script"]
            scripts.append(script)
            # Supply the evaluated IPC result without launching a WebView or
            # making a network request. Decode it with the real W3C transport.
            if script.startswith("return "):
                value = ({"observation": result}
                         if script.startswith("return {observation:") else result)
            else:
                value = True
            body = json.dumps({"value": value}).encode()
            stream = Mock()
            stream.__enter__ = Mock(return_value=stream)
            stream.__exit__ = Mock(return_value=False)
            stream.read.return_value = body
            return stream

        session._open = Mock(side_effect=response)
        return session, scripts

    def test_disabled_ipc_is_observed_without_becoming_a_webdriver_failure(self):
        rejection = {"done": True, "error": {"code": -32009,
                                              "message": "plugin hello-plugin is disabled"}}
        session, scripts = self.session_with_ipc_result(rejection)
        observed = invoke(session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
        self.assertEqual(observed, rejection)
        check({"state": "installed"}, observed, "installed")
        check({"state": "disabled"}, observed, "disabled")
        check({"state": "uninstalled"}, observed, "uninstalled")
        self.assertTrue(scripts[-1].startswith("delete window["))

    def test_success_keeps_the_real_host_identity_and_releases_the_slot(self):
        result = {"done": True, "value": {"pluginId": "taomni-plugin-hello-plugin",
                                          "version": "0.1.0", "enabled": True}}
        session, scripts = self.session_with_ipc_result(result)
        observed = invoke(session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
        self.assertEqual(observed, result)
        check({"state": "enabled", "reason": None}, observed, "enabled")
        self.assertTrue(scripts[-1].startswith("delete window["))

    def test_real_webdriver_errors_still_fail_and_release_the_observation_slot(self):
        session = Mock()
        session.execute.side_effect = [True, WebDriverError("session disconnected"), True]
        with self.assertRaisesRegex(WebDriverError, "session disconnected"):
            invoke(session, "plugin_list")
        self.assertTrue(session.execute.call_args.args[0].startswith("delete window["))


if __name__ == "__main__":
    unittest.main()
