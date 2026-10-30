"""Paced native input keeps every key while avoiding a request per character."""
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from tauri_webdriver import NativeSession, WebDriverError


class NativePacedInputTest(unittest.TestCase):
    def session(self):
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "owned-input"
        session.request = Mock(return_value=None)
        return session

    def test_all_webviews_retain_every_key_and_pause_in_one_request(self):
        for system in ("Darwin", "Linux", "Windows"):
            with self.subTest(system=system), patch("tauri_webdriver.platform.system", return_value=system):
                session = self.session()
                self.assertEqual(session.type_text("ab"), "typed 2 chars")
                self.assertEqual(session.request.call_count, 2)
                post, release = session.request.call_args_list
                self.assertEqual(post.args[:2], ("POST", "/session/owned-input/actions"))
                self.assertEqual(post.args[2]["actions"], [{
                    "type": "key", "id": "keyboard", "actions": [
                        {"type": "keyDown", "value": "a"},
                        {"type": "keyUp", "value": "a"},
                        {"type": "pause", "duration": 20},
                        {"type": "keyDown", "value": "b"},
                        {"type": "keyUp", "value": "b"},
                        {"type": "pause", "duration": 20},
                    ],
                }])
                self.assertEqual(release.args, ("DELETE", "/session/owned-input/actions"))

    def test_uppercase_releases_shift_before_the_next_character(self):
        session = self.session()
        session.type_text("A;")
        actions = session.request.call_args_list[0].args[2]["actions"][0]["actions"]
        self.assertEqual(actions, [
            {"type": "keyDown", "value": "\uE008"},
            {"type": "keyDown", "value": "A"},
            {"type": "keyUp", "value": "A"},
            {"type": "keyUp", "value": "\uE008"},
            {"type": "pause", "duration": 20},
            {"type": "keyDown", "value": ";"},
            {"type": "keyUp", "value": ";"},
            {"type": "pause", "duration": 20},
        ])

    def test_uncertain_input_is_never_replayed_and_releases_its_source(self):
        session = self.session()
        session.request.side_effect = [WebDriverError("input interrupted"), WebDriverError("release failed")]
        with self.assertRaisesRegex(WebDriverError, "input interrupted"):
            session.type_text("abc")
        self.assertEqual([call.args[0] for call in session.request.call_args_list], ["POST", "DELETE"])

    def test_empty_input_does_not_create_an_input_source(self):
        session = self.session()
        self.assertEqual(session.type_text(""), "typed 0 chars")
        session.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
