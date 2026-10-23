import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from qa_ui_auto.window_context import native_switch, arguments


class WindowContextTests(unittest.TestCase):
    def test_selects_the_actual_matching_webview_and_installs_observation(self):
        session = Mock()
        session.endpoint.side_effect = lambda path: '/session/owned' + path
        session.request.side_effect = [['main', 'detached'], None, None]
        session.execute.side_effect = [False, True]
        result = native_switch(SimpleNamespace(session=session), {'selector': '[data-testid="detached-reattach"]'})
        self.assertIn('detached', result)
        self.assertEqual(session.request.call_args.args, ('POST', '/session/owned/window', {'handle': 'detached'}))
        session.install_console_hook.assert_called_once()
        self.assertNotIn('invoke', session.execute.call_args.args[0])

    def test_requires_explicit_selector(self):
        for value in [None, {}, {'selector': ''}]:
            with self.assertRaises(RuntimeError): arguments(value)


if __name__ == '__main__': unittest.main()
