"""Single-sequence input and stale-preparation contracts; no application launch."""
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, call, patch

from tauri_webdriver import NativeSession
from native_webdriver_transport import WebDriverError


class NativeDoubleClickContracts(TestCase):
    def setUp(self):
        self.ready = patch("native_doubleclick.prepare_click_target", return_value={"x": 70, "y": 52}).start()
        self.addCleanup(patch.stopall)
        self.session = NativeSession("http://driver.invalid", Path("unused"))
        self.session.session_id = "session-1"
        self.session.find = Mock(return_value="row")
        self.session.request = Mock()
        self.session.execute = Mock()

    def test_refreshed_row_is_hit_tested_before_one_trusted_sequence(self):
        self.session.find.side_effect = ["old-row", "new-row"]
        self.ready.side_effect = [WebDriverError("stale element reference"), {"x": 70, "y": 52}]
        with patch("native_doubleclick.time.sleep"):
            self.session.dblclick("#row")
        self.assertEqual(self.ready.call_args_list, [
            call(self.session, {"element-6066-11e4-a52e-4f735466cecf": "old-row"}),
            call(self.session, {"element-6066-11e4-a52e-4f735466cecf": "new-row"}),
        ])
        requests = self.session.request.call_args_list
        self.assertEqual(requests[0].args[2]["args"], [{"element-6066-11e4-a52e-4f735466cecf": "old-row"}])
        self.assertEqual(requests[1].args[2]["args"], [{"element-6066-11e4-a52e-4f735466cecf": "new-row"}])
        actions = requests[2].args[2]["actions"][0]
        self.assertEqual(actions["id"], "mouse")
        self.assertEqual(actions["actions"][0], {"type": "pointerMove", "duration": 0, "origin": "viewport", "x": 70, "y": 52})
        self.assertEqual([item["type"] for item in actions["actions"]].count("pointerDown"), 2)
        self.assertEqual(requests[-1].args, ("DELETE", "/session/session-1/actions"))
        self.session.execute.assert_not_called()

    def test_persistent_stale_geometry_fails_without_button_input(self):
        self.ready.side_effect = WebDriverError("stale element reference")
        with patch("native_doubleclick.time.sleep"), self.assertRaisesRegex(WebDriverError, "stale element reference"):
            self.session.dblclick("#row")
        self.assertEqual(self.session.find.call_count, 3)
        self.assertTrue(all(request.args[1].endswith("/execute/sync") for request in self.session.request.call_args_list))
        self.session.execute.assert_not_called()

    def test_ambiguous_transport_error_is_not_replayed_and_sources_are_released(self):
        self.session.request.side_effect = [None, WebDriverError("stale element reference"), None]
        with self.assertRaisesRegex(WebDriverError, "stale element reference"):
            self.session.dblclick("#row")
        self.session.find.assert_called_once()
        inputs = [request for request in self.session.request.call_args_list if request.args[:2] == ("POST", "/session/session-1/actions")]
        self.assertEqual(len(inputs), 1)
        self.assertEqual(self.session.request.call_args.args, ("DELETE", "/session/session-1/actions"))
        self.session.execute.assert_not_called()

    def test_covered_target_is_not_replaced_by_synthetic_activation(self):
        self.ready.side_effect = WebDriverError("element click intercepted")
        with self.assertRaisesRegex(WebDriverError, "element click intercepted"):
            self.session.dblclick("#row")
        self.session.find.assert_called_once()
        self.session.execute.assert_not_called()
        self.assertFalse(any(request.args[1].endswith("/actions") for request in self.session.request.call_args_list))
