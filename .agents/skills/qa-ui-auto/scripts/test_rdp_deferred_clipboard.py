"""Validate the diagnostic boundary; actual AppKit behavior needs hosted macOS."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto import host_clipboard
from qa_ui_auto.fixtures import rdp_deferred_clipboard as deferred


class DeferredClipboardTest(unittest.TestCase):
    def test_publication_preserves_native_observations(self):
        observation = {"declaredToken": 31, "publishedToken": 31,
                       "heldMs": 1201, "published": True}
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "observation.json"
            with patch.object(host_clipboard, "_jxa", return_value=json.dumps(observation)) as native:
                deferred.publish(deferred.TARGET_TEXT, destination)
            native.assert_called_once_with(deferred.SCRIPT, deferred.TARGET_TEXT)
            self.assertEqual(json.loads(destination.read_text()), observation)

    def test_invalid_native_publication_is_not_a_product_reproduction(self):
        for changes, message in [
            ({"declaredToken": None, "publishedToken": None}, "incomplete"),
            ({"published": False}, "rejected"),
            ({"publishedToken": 32}, "changed the token"),
            ({"heldMs": 1199}, "did not hold"),
        ]:
            observation = {"declaredToken": 31, "publishedToken": 31,
                           "heldMs": 1201, "published": True, **changes}
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "observation.json"
                with patch.object(host_clipboard, "_jxa", return_value=json.dumps(observation)):
                    with self.assertRaisesRegex(RuntimeError, message):
                        deferred.publish(deferred.TARGET_TEXT, destination)
                self.assertEqual(json.loads(destination.read_text()), observation)

    def test_malformed_native_output_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(host_clipboard, "_jxa", return_value="not-json"):
                with self.assertRaises(json.JSONDecodeError):
                    deferred.publish(deferred.TARGET_TEXT, Path(directory) / "observation.json")

    def test_only_target_write_is_deferred_and_teardown_restores_the_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(case_dir=directory)
            original = Mock()
            with patch.object(host_clipboard, "set_text", original), \
                 patch("platform.system", return_value="Darwin"), \
                 patch.object(deferred, "publish") as publish:
                deferred.setup(ctx)
                try:
                    host_clipboard.set_text("restore original text")
                    original.assert_called_once_with("restore original text")
                    host_clipboard.set_text(deferred.TARGET_TEXT)
                    publish.assert_called_once_with(
                        deferred.TARGET_TEXT, Path(directory) / "deferred-clipboard-publication.json")
                finally:
                    deferred.teardown(ctx)
                self.assertIs(host_clipboard.set_text, original)
                deferred.teardown(ctx)
                self.assertIs(host_clipboard.set_text, original)

    def test_other_platforms_keep_the_real_setter(self):
        original = host_clipboard.set_text
        with patch("platform.system", return_value="Linux"):
            deferred.setup(SimpleNamespace())
            deferred.teardown(SimpleNamespace())
        self.assertIs(host_clipboard.set_text, original)


if __name__ == "__main__":
    unittest.main()
