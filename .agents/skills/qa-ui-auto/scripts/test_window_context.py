import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from qa_ui_auto.window_context import native_switch, browser_switch, arguments
from native_webdriver_transport import WebDriverError


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
        for value in [None, {}, {'selector': ''}, {'selector': '#main', 'close_with': ''}]:
            with self.assertRaises(RuntimeError): arguments(value)

    def test_reattach_click_may_close_its_source_before_webdriver_acknowledges(self):
        session = Mock()
        session.endpoint.side_effect = lambda path: '/session/owned' + path
        session.request.side_effect = ['detached', ['detached', 'main'], ['main'], None]
        session.click.side_effect = WebDriverError('HTTP 404: no such window')
        session.execute.return_value = True
        with patch('qa_ui_auto.window_context.time.sleep'):
            result = native_switch(SimpleNamespace(session=session), {
                'selector': '#main', 'close_with': '#reattach', 'timeout_sec': 1})
        self.assertIn('main', result)
        session.click.assert_called_once_with('#reattach')
        session.execute.assert_called_once()

    def test_expected_close_never_replays_a_click_or_accepts_a_surviving_source(self):
        session = Mock()
        session.endpoint.side_effect = lambda path: '/session/owned' + path
        session.request.side_effect = ['detached', ['detached', 'main']]
        session.click.side_effect = WebDriverError('HTTP 404: no such window')
        with patch('qa_ui_auto.window_context.time.monotonic', side_effect=[0, 0, 2]), \
                patch('qa_ui_auto.window_context.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'source window did not close'):
                native_switch(SimpleNamespace(session=session), {
                    'selector': '#main', 'close_with': '#reattach', 'timeout_sec': 1})
        session.click.assert_called_once()
        session.execute.assert_not_called()

    def test_expected_close_preserves_other_driver_errors(self):
        session = Mock()
        session.request.return_value = 'detached'
        session.click.side_effect = WebDriverError('HTTP 500: disconnected')
        with self.assertRaisesRegex(WebDriverError, 'disconnected'):
            native_switch(SimpleNamespace(session=session), {'selector': '#main', 'close_with': '#reattach'})
        session.request.assert_called_once()

    def test_webkit_evaluation_timeout_recovers_only_after_observed_window_closure(self):
        for closes in [True, False]:
            with self.subTest(closes=closes):
                session = Mock()
                session.endpoint.side_effect = lambda path: '/session/owned' + path
                session.request.side_effect = ['detached', ['main'] if closes else ['detached', 'main'], None]
                session.click.side_effect = WebDriverError('WebView JavaScript evaluation timed out')
                session.execute.return_value = True
                with patch('qa_ui_auto.window_context.time.monotonic', side_effect=[0, 0, 2]), \
                        patch('qa_ui_auto.window_context.time.sleep'):
                    ctx = SimpleNamespace(session=session)
                    args = {'selector': '#main', 'close_with': '#reattach', 'timeout_sec': 1}
                    if closes:
                        self.assertIn('main', native_switch(ctx, args))
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'source window did not close'):
                            native_switch(ctx, args)
                        session.execute.assert_not_called()
                session.click.assert_called_once()

    def test_lost_close_ack_observes_window_state_after_dispatch_consumes_poll_budget(self):
        for closes in [True, False]:
            with self.subTest(closes=closes):
                session = Mock()
                session.endpoint.side_effect = lambda path: '/session/owned' + path
                session.request.side_effect = ['detached', ['main'] if closes else ['detached', 'main'], None]
                session.click.side_effect = WebDriverError('WebView JavaScript evaluation timed out')
                session.execute.return_value = True
                with patch('qa_ui_auto.window_context.time.monotonic', side_effect=[0, 60, 61]), \
                        patch('qa_ui_auto.window_context.time.sleep'):
                    args = {'selector': '#main', 'close_with': '#reattach', 'timeout_sec': 45}
                    if closes:
                        self.assertIn('main', native_switch(SimpleNamespace(session=session), args))
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'source window did not close'):
                            native_switch(SimpleNamespace(session=session), args)
                        session.execute.assert_not_called()
                session.click.assert_called_once_with('#reattach')
                session.request.assert_any_call('GET', '/session/owned/window/handles')

    def test_real_window_observations_record_source_closure_and_selected_context(self):
        import json
        session = Mock()
        session.endpoint.side_effect = lambda path: '/session/owned' + path
        session.request.side_effect = ['detached', ['main'], None]
        session.execute.return_value = True
        with tempfile.TemporaryDirectory() as directory:
            ctx = SimpleNamespace(session=session, case_dir=Path(directory))
            native_switch(ctx, {'selector': '#main', 'close_with': '#reattach'})
            entries = [json.loads(line) for line in
                       (ctx.case_dir / 'native-window-context.jsonl').read_text().splitlines()]
        self.assertEqual([entry['phase'] for entry in entries], ['close', 'windows', 'selected'])
        self.assertEqual(entries[1]['handles'], ['main'])
        self.assertTrue(entries[1]['source_closed'])
        self.assertEqual(entries[2]['handle'], 'main')
        session.click.assert_called_once_with('#reattach')

    def test_browser_reattach_selects_the_surviving_page_after_observed_closure(self):
        source, main = Mock(), Mock()
        source.context.pages = [source, main]
        source.is_closed.return_value = True
        main.is_closed.return_value = False
        source.locator.return_value.first.click.side_effect = RuntimeError('target closed')
        main.locator.return_value.count.return_value = 1
        ctx = SimpleNamespace(page=source)
        browser_switch(ctx, {'selector': '#main', 'close_with': '#reattach'})
        self.assertIs(ctx.page, main)
        source.locator.assert_called_once_with('#reattach')
        source.locator.return_value.first.click.assert_called_once_with()
        main.bring_to_front.assert_called_once_with()

    def test_browser_expected_close_does_not_hide_a_click_failure_in_a_live_page(self):
        source = Mock()
        source.is_closed.return_value = False
        source.locator.return_value.first.click.side_effect = RuntimeError('intercepted')
        with self.assertRaisesRegex(RuntimeError, 'intercepted'):
            browser_switch(SimpleNamespace(page=source), {'selector': '#main', 'close_with': '#reattach'})


if __name__ == '__main__': unittest.main()
