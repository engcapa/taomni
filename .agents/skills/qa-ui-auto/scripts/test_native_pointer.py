import json
import subprocess
from itertools import chain, cycle, repeat
from unittest import TestCase
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, call, patch

from tauri_webdriver import NativeSession
import native_pointer_buttons as buttons

from native_pointer import MOUSE_SOURCE, TARGET_GEOMETRY, click_viewport_point, prepare_click_target, prepare_pointer_target
from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import CaseTimeout, Deadline


class NativeClickLifecycleTest(TestCase):
    """Retained W3C contracts, including unchanged Windows/macOS behavior."""
    def setUp(self):
        target = patch('tauri_webdriver.prepare_click_target', return_value={'x': 270, 'y': 217})
        self.prepare_pointer_target = target.start()
        self.addCleanup(target.stop)
        system = patch('native_pointer.platform.system', return_value='Windows')
        system.start()
        self.addCleanup(system.stop)
        self.session = NativeSession('http://driver.invalid', Path('unused'))
        self.session.session_id = 'session-1'
        self.session.find = Mock(return_value='row-1')
        self.session.request = Mock()

    def test_modified_click_holds_keys_through_pointer_up_and_releases_them_on_failure(self):
        session = self.session
        session.request.side_effect = [None, WebDriverError('input failed'), None]
        with self.assertRaisesRegex(WebDriverError, 'input failed'):
            session.pointer_button_click('#row', 0, ['Control', 'Shift'])
        keys, pointer = session.request.call_args_list[1].args[2]['actions']
        self.assertEqual(pointer['id'], MOUSE_SOURCE)
        self.assertEqual(len(keys['actions']), len(pointer['actions']))
        self.assertEqual(keys['actions'][:2], [{'type': 'keyDown', 'value': ''}, {'type': 'keyDown', 'value': ''}])
        self.assertEqual(keys['actions'][-2:], [{'type': 'keyUp', 'value': ''}, {'type': 'keyUp', 'value': ''}])
        self.assertEqual(pointer['actions'][3:5], [{'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}])
        self.assertEqual(session.request.call_args, call('DELETE', '/session/session-1/actions'))

    def test_windows_and_macos_nonleft_clicks_keep_w3c_payload_and_source(self):
        for system in ('Windows', 'Darwin'):
            for button in (1, 2):
                with self.subTest(system=system, button=button), patch('native_pointer.platform.system', return_value=system):
                    self.session.request.reset_mock()
                    self.session.pointer_button_click('#row', button)
                    actions = self.session.request.call_args_list[1].args[2]['actions'][0]
                    self.assertEqual(actions['id'], MOUSE_SOURCE)
                    self.assertEqual(actions['actions'][1:], [{'type': 'pointerDown', 'button': button}, {'type': 'pointerUp', 'button': button}])
                    self.session.request.assert_called_with('DELETE', '/session/session-1/actions')

    def test_right_click_uses_right_button_and_releases_on_failure(self):
        session = self.session
        session.request.side_effect = [None, RuntimeError('input failed'), None]
        with self.assertRaisesRegex(RuntimeError, 'input failed'):
            session.right_click('#file')
        actions = session.request.call_args_list[1].args[2]['actions'][0]['actions']
        self.assertEqual(actions[0]['origin'], 'viewport')
        self.assertEqual((actions[0]['x'], actions[0]['y']), (270, 217))
        self.assertEqual([a['button'] for a in actions[1:]], [2, 2])
        self.assertEqual(session.request.call_args.args, ('DELETE', '/session/session-1/actions'))
        self.assertNotIn('dispatchEvent', session.request.call_args_list[0].args[2]['script'])

    def test_pointer_click_retries_a_stale_element_reference(self):
        session = self.session
        session.find.side_effect = ['row-1', 'row-2']
        session.request.side_effect = [WebDriverError('stale element reference: element is not attached to the page document'), None, None, None, None]
        with patch('native_pointer.time.sleep') as sleep:
            session.right_click('#file')
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        actions_call = next(c for c in session.request.call_args_list if c.args[0] == 'POST' and c.args[1].endswith('/actions'))
        actions = actions_call.args[2]['actions'][0]['actions']
        self.assertEqual(actions[0]['origin'], 'viewport')
        self.prepare_pointer_target.assert_called_once_with(session, {'element-6066-11e4-a52e-4f735466cecf': 'row-2'}, allow_alternate=True)
        self.assertEqual([a['button'] for a in actions[1:]], [2, 2])

    def test_click_retries_webkit_stale_element_error(self):
        session = self.session
        session.find.side_effect = ['button-1', 'button-2']
        session.request.side_effect = [WebDriverError('HTTP 400: {"message":"JavaScript error: Error: stale element"}'), None, None, None]
        with patch('native_pointer.time.sleep') as sleep:
            session.click('#section')
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        self.assertEqual([c.args[1] for c in session.request.call_args_list if c.args[0] == 'POST' and c.args[1].endswith('/actions')], ['/session/session-1/actions'])
        self.prepare_pointer_target.assert_called_once_with(session, {'element-6066-11e4-a52e-4f735466cecf': 'button-2'}, allow_alternate=False)

    def test_click_keeps_intercepted_target_a_failure_without_synthetic_activation(self):
        session = self.session
        session.request.side_effect = [None, WebDriverError('element click intercepted'), None]
        session.execute = Mock()
        with self.assertRaisesRegex(WebDriverError, 'element click intercepted'):
            session.click('#section')
        session.find.assert_called_once()
        session.execute.assert_not_called()
        self.assertEqual(sum(c.args[1].endswith('/actions') and c.args[0] == 'POST' for c in session.request.call_args_list), 1)

    def test_pointer_click_retries_a_null_element_scroll_error(self):
        session = self.session
        session.find.side_effect = ['row-1', 'row-2']
        session.request.side_effect = [WebDriverError("HTTP 400: TypeError: null is not an object (evaluating 'arguments[0].scrollIntoView')"), None, None, None, None]
        with patch('native_pointer.time.sleep') as sleep:
            session.right_click('#file')
        self.assertEqual(session.find.call_count, 2)
        sleep.assert_called_once_with(0.3)
        actions_call = next(c for c in session.request.call_args_list if c.args[0] == 'POST' and c.args[1].endswith('/actions'))
        self.assertEqual(actions_call.args[2]['actions'][0]['actions'][0]['origin'], 'viewport')
        self.prepare_pointer_target.assert_called_once_with(session, {'element-6066-11e4-a52e-4f735466cecf': 'row-2'}, allow_alternate=True)

    def test_pointer_click_gives_up_after_three_stale_references(self):
        self.session.request.side_effect = WebDriverError('stale element reference')
        with patch('native_pointer.time.sleep'):
            with self.assertRaisesRegex(WebDriverError, 'stale element reference'):
                self.session.right_click('#file')
        self.assertEqual(self.session.find.call_count, 3)

    def test_pointer_click_never_replays_an_ambiguous_action_error(self):
        def request(method, path, *args):
            if method == 'POST' and path.endswith('/actions'):
                raise WebDriverError('stale element reference')
        self.session.request.side_effect = request
        with self.assertRaisesRegex(WebDriverError, 'stale element reference'):
            self.session.right_click('#file')
        self.session.find.assert_called_once()
        self.assertEqual(sum(c.args[:2] == ('POST', '/session/session-1/actions') for c in self.session.request.call_args_list), 1)
        self.assertEqual(self.session.request.call_args, call('DELETE', '/session/session-1/actions'))


class LinuxClickRoutingTest(TestCase):
    def setUp(self):
        self.session = NativeSession('http://driver.invalid', Path('unused'))
        self.session.session_id = 'session-1'
        self.session.find = Mock(return_value='row')
        self.session.request = Mock()
        self.session._window_focus.data_home = '/qa/private/data'
        self.addCleanup(patch.stopall)
        patch('native_pointer.platform.system', return_value='Linux').start()
        patch.dict('os.environ', {'DISPLAY': ':99', 'GDK_BACKEND': 'x11'}).start()
        self.prepare = patch('native_pointer.prepare_x11_button_target', return_value='owned target').start()
        self.click = patch('native_pointer.click_x11_button', return_value={'transport': 'X11 native'}).start()
        self.geometry = patch('tauri_webdriver.prepare_click_target', return_value={'x': 20, 'y': 30}).start()

    def test_right_and_middle_use_no_w3c_button_down(self):
        for button in (1, 2):
            with self.subTest(button=button):
                self.session.request.reset_mock()
                result = self.session.pointer_button_click('#row', button)
                self.assertIn('via X11 native', result)
                self.click.assert_called_with(self.session, 'owned target', button, selector='#row')
                self.prepare.assert_called_with(self.session, {'element-6066-11e4-a52e-4f735466cecf': 'row'},
                    data_home='/qa/private/data', allow_alternate=button == 2, prepare_target=self.geometry)
                self.assertTrue(all(not c.args[1].endswith('/actions') for c in self.session.request.call_args_list))

    def test_left_click_is_unchanged(self):
        self.session.click('#row')
        self.prepare.assert_not_called()
        self.click.assert_not_called()
        self.assertEqual(self.session.request.call_args, call('DELETE', '/session/session-1/actions'))

    def test_stale_preparation_can_retry_but_ambiguous_click_cannot(self):
        self.prepare.side_effect = [WebDriverError('stale element'), 'owned target']
        with patch('native_pointer.time.sleep'):
            self.session.right_click('#row')
        self.assertEqual(self.session.find.call_count, 2)
        self.click.assert_called_once()
        self.click.side_effect = WebDriverError('stale element during native transport')
        self.prepare.side_effect = None
        self.session.find.reset_mock()
        with self.assertRaisesRegex(WebDriverError, 'during native transport'):
            self.session.right_click('#row')
        self.session.find.assert_called_once()
        self.assertEqual(self.click.call_count, 2)

    def test_unsupported_desktops_and_modifiers_fail_before_input_without_fallback(self):
        for environment, modifiers in (({'GDK_BACKEND': 'wayland,x11'}, []),
                ({'DISPLAY': ''}, []), ({}, ['Control'])):
            with self.subTest(environment=environment, modifiers=modifiers), patch.dict('os.environ', environment):
                with self.assertRaisesRegex(WebDriverError, 'X11|modifiers'):
                    self.session.pointer_button_click('#row', 2, modifiers)
        self.session.find.assert_not_called()
        self.session.request.assert_not_called()
        self.click.assert_not_called()


class X11ButtonLifecycleTest(TestCase):
    def setUp(self):
        self.session = Mock(session_id='qa-session', pointer_observations_path=None)
        self.session.application = Path('/qa/app')
        self.session.endpoint.side_effect = lambda suffix: '/session/qa' + suffix
        self.viewport = {'title': 'Taomni QA', 'width': 1000, 'height': 700}
        self.session.request.return_value = self.viewport
        self.point = {'x': 270, 'y': 217}
        self.geometry = {'x': 120, 'y': 140, 'width': 1000, 'height': 700}
        self.addCleanup(patch.stopall)
        self.owned_window_impl = buttons._owned_window
        self.owner = patch('native_pointer_buttons._owned_window', return_value=('0x123', 42)).start()
        self.window_geometry = patch('native_pointer_buttons.window_geometry', return_value=self.geometry).start()
        self.command = patch('native_pointer_buttons.command', return_value='291').start()
        self.physical_point = {'x': 0, 'y': 0}
        def command_result(*args):
            if args[1] == 'mousemove':
                self.physical_point = {'x': self.geometry['x'] + int(args[-2]),
                                       'y': self.geometry['y'] + int(args[-1])}
                return ''
            if args[1] == 'getmouselocation':
                return f"X={self.physical_point['x']}\nY={self.physical_point['y']}\nSCREEN=0\nWINDOW=291\n"
            return '291'
        self.command.side_effect = command_result
        self.prepare = Mock(return_value=self.point)

    def prepare_target(self):
        return buttons.prepare_x11_button_target(self.session, {'element': 'row'}, data_home='/qa/data',
            allow_alternate=True, prepare_target=self.prepare)

    def test_real_hover_rechecks_target_before_one_balanced_button_click(self):
        target = self.prepare_target()
        observation = buttons.click_x11_button(self.session, target, 2, selector='#row')
        self.command.assert_any_call('xdotool', 'mousemove', '--window', '0x123', '270', '217')
        self.command.assert_called_with('xdotool', 'click', '3')
        self.assertEqual(self.prepare.call_count, 2)
        self.assertEqual(observation['status'], 'completed')
        self.assertEqual(observation['transport'], 'X11 xdotool -> GTK/WebKitGTK')
        self.assertIs(self.session.last_pointer_click, observation)
        self.assertTrue(all(c.args[1].endswith('/execute/async') for c in self.session.request.call_args_list))

    def test_repeated_noop_hover_reads_position_without_waiting_for_motion_event(self):
        first = self.prepare_target()
        second = self.prepare_target()
        self.assertEqual(first.local_point, second.local_point)
        moves = [entry for entry in self.command.call_args_list if entry.args[1] == 'mousemove']
        self.assertEqual(len(moves), 2)
        self.assertTrue(all('--sync' not in entry.args for entry in moves))
        self.command.assert_any_call('xdotool', 'getmouselocation', '--shell')

    def test_failed_physical_position_observation_cannot_authorize_click(self):
        self.command.side_effect = lambda *args: 'X=1\nY=2\n' if args[1] == 'getmouselocation' else '291'
        with self.assertRaisesRegex(WebDriverError, 'did not reach the owned target'):
            self.prepare_target()
        self.assertFalse(any('click' in entry.args for entry in self.command.call_args_list))

    def test_physical_client_size_scales_viewport_coordinates(self):
        self.window_geometry.return_value = {**self.geometry, 'width': 2000, 'height': 1400}
        target = self.prepare_target()
        self.assertEqual(target.local_point, {'x': 540, 'y': 434})
        self.command.assert_any_call('xdotool', 'mousemove', '--window', '0x123', '540', '434')
        buttons.click_x11_button(self.session, target, 1, selector='#row')
        self.command.assert_called_with('xdotool', 'click', '2')

    def test_hover_moving_layout_can_repeat_preparation_but_never_button_input(self):
        self.prepare.side_effect = [self.point, {'x': 270, 'y': 240}, self.point, self.point]
        self.prepare_target()
        self.assertEqual(self.prepare.call_count, 4)
        self.assertFalse(any('click' in c.args or 'mousedown' in c.args for c in self.command.call_args_list))
        self.prepare.side_effect = [self.point, {'x': 270, 'y': 240}] * 3
        with self.assertRaisesRegex(WebDriverError, 'moved during physical'):
            self.prepare_target()
        self.assertFalse(any('click' in c.args for c in self.command.call_args_list))

    def test_missing_profile_or_invalid_native_geometry_never_sends_a_button(self):
        with self.assertRaisesRegex(WebDriverError, 'isolated XDG_DATA_HOME'):
            buttons.prepare_x11_button_target(self.session, {}, data_home=None,
                allow_alternate=True, prepare_target=self.prepare)
        for invalid in (None, {'title': 'Taomni QA'}, {**self.viewport, 'width': 0},
                        {**self.viewport, 'height': float('nan')}):
            with self.subTest(invalid=invalid):
                self.session.request.return_value = invalid
                with self.assertRaisesRegex(WebDriverError, 'identify the native'):
                    self.prepare_target()
        self.command.assert_not_called()

    def test_ownership_focus_or_geometry_change_prevents_input(self):
        target = self.prepare_target()
        for mutation in ('owner', 'viewport', 'geometry', 'focus'):
            with self.subTest(mutation=mutation):
                self.command.reset_mock()
                self.owner.return_value = ('0x999', 42) if mutation == 'owner' else ('0x123', 42)
                self.session.request.return_value = {**self.viewport, 'title': 'Changed'} if mutation == 'viewport' else self.viewport
                self.window_geometry.return_value = {**self.geometry, 'y': 300} if mutation == 'geometry' else self.geometry
                self.command.side_effect = None
                self.command.return_value = '999' if mutation == 'focus' else '291'
                with self.assertRaisesRegex(WebDriverError, 'changed before input'):
                    buttons.click_x11_button(self.session, target, 2, selector='#row')
                self.assertFalse(any('click' in c.args or 'mouseup' in c.args for c in self.command.call_args_list))

    def test_ambiguous_click_sends_release_only_never_a_second_press(self):
        target = self.prepare_target()
        self.command.reset_mock()
        def dispatch(*args):
            if args[1] == 'getactivewindow':
                return '291'
            if args[1] == 'click':
                raise WebDriverError('native input delivery uncertain')
            raise RuntimeError('release transport failed')
        self.command.side_effect = dispatch
        with self.assertRaisesRegex(WebDriverError, 'delivery uncertain'):
            buttons.click_x11_button(self.session, target, 2, selector='#row')
        self.assertEqual(self.command.call_args_list, [call('xdotool', 'getactivewindow'),
            call('xdotool', 'click', '3'), call('xdotool', 'mouseup', '3')])
        self.assertEqual(self.session.last_pointer_click['status'], 'failed')

    def test_receipt_records_session_selector_and_lifecycle_without_native_title_or_profile(self):
        target = self.prepare_target()
        with TemporaryDirectory() as directory:
            self.session.pointer_observations_path = Path(directory) / 'native-pointer-clicks.jsonl'
            buttons.click_x11_button(self.session, target, 2, selector='#row')
            self.command.side_effect = lambda *args: '291' if args[1] == 'getactivewindow' else (_ for _ in ()).throw(OSError('uncertain input'))
            with self.assertRaisesRegex(OSError, 'uncertain input'):
                buttons.click_x11_button(self.session, target, 1, selector='#another-row')
            records = [json.loads(line) for line in self.session.pointer_observations_path.read_text().splitlines()]
        self.assertEqual([r['status'] for r in records], ['completed', 'failed'])
        self.assertEqual([r['selector'] for r in records], ['#row', '#another-row'])
        self.assertTrue(all(r['session_id'] == 'qa-session' for r in records))
        self.assertTrue(all(r['finished_at_unix_ms'] >= r['started_at_unix_ms'] for r in records))
        self.assertEqual(records[1]['error_type'], 'OSError')
        self.assertNotIn('Taomni QA', json.dumps(records))
        self.assertNotIn('/qa/data', json.dumps(records))

    def test_native_title_failure_reports_error_and_missing_geometry_without_input(self):
        self.session.request.return_value = {'error': 'window.title not permitted'}
        with self.assertRaisesRegex(WebDriverError, 'title not permitted'):
            self.prepare_target()
        self.command.assert_not_called()

    def test_webkit_right_click_followed_by_double_click_and_left_press_has_clean_buttons(self):
        # Model the upstream bug boundary (Session.cpp pointerUp drops the
        # button, GTK maps None to PRIMARY; DELETE resets sources only).
        # This reproduces the CI buttons=2 -> 3 -> 2 leak with the old payload,
        # and proves our non-left route never enters that state at all.
        gtk_mask = 0
        dom_mask = 0
        observed = []
        def w3c(method, path, payload=None):
            nonlocal gtk_mask, dom_mask
            if not path.endswith('/actions') or method != 'POST':
                return
            for source in payload['actions']:
                for action in source['actions']:
                    if action['type'] == 'pointerDown':
                        gtk_mask |= {0: 1, 1: 4, 2: 2}[action['button']]
                    elif action['type'] == 'pointerUp':
                        gtk_mask &= ~1
                    dom_mask = gtk_mask
        def os_input(*args):
            nonlocal dom_mask
            if args[1] == 'getactivewindow':
                return '291'
            if args[1] == 'click':
                dom_mask = 2
                dom_mask = 0
            return ''
        def left_sequence():
            w3c('POST', '/session/qa/actions', {'actions': [{'actions': [
                {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0},
                {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}]}]})
            observed.append(dom_mask)
            w3c('POST', '/session/qa/actions', {'actions': [{'actions': [{'type': 'pointerDown', 'button': 0}]}]})
            observed.append(dom_mask)
            w3c('POST', '/session/qa/actions', {'actions': [{'actions': [{'type': 'pointerUp', 'button': 0}]}]})
            observed.append(dom_mask)
        w3c('POST', '/session/qa/actions', {'actions': [{'actions': [
            {'type': 'pointerDown', 'button': 2}, {'type': 'pointerUp', 'button': 2}]}]})
        w3c('DELETE', '/session/qa/actions')
        left_sequence()
        self.assertEqual(observed, [2, 3, 2])
        gtk_mask = dom_mask = 0
        observed.clear()
        target = self.prepare_target()
        self.command.side_effect = os_input
        buttons.click_x11_button(self.session, target, 2, selector='#row')
        self.assertEqual(gtk_mask, 0)
        left_sequence()
        self.assertEqual(observed, [0, 1, 0])

    def test_pid_executable_and_captured_profile_must_all_match(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            application = root / 'qa-app'
            application.touch()
            foreign = root / 'other-app'
            foreign.touch()
            for pid, executable, profile in ((42, application, '/qa/data'),
                    (43, application, '/qa/other'), (44, foreign, '/qa/data')):
                entry = root / str(pid)
                entry.mkdir()
                (entry / 'exe').symlink_to(executable)
                (entry / 'environ').write_bytes(f'XDG_DATA_HOME={profile}\0'.encode())
            for pid, expected in ((42, True), (43, False), (44, False), (45, False)):
                self.assertEqual(buttons._owned_process(application, '/qa/data', pid, root), expected)

    def test_duplicate_or_foreign_windows_never_authorize_input(self):
        with patch('native_pointer_buttons._owned_process', side_effect=lambda app, data, pid: pid == 42), \
                patch('native_pointer_buttons.managed_windows') as windows:
            self.command.side_effect = None
            self.command.return_value = 'Taomni QA'
            for candidates, expected in (([('0x1', 42)], ('0x1', 42)),
                    ([('0x1', 99)], None), ([('0x1', 42), ('0x2', 42)], None)):
                with self.subTest(candidates=candidates):
                    windows.return_value = candidates
                    if expected:
                        self.assertEqual(self.owned_window_impl(Path('/qa/app'), '/qa/data', 'Taomni QA'), expected)
                    else:
                        with self.assertRaisesRegex(WebDriverError, 'one exact QA profile/window'):
                            self.owned_window_impl(Path('/qa/app'), '/qa/data', 'Taomni QA')
            windows.return_value = [('0x1', 42)]
            self.command.return_value = 'Foreign title'
            with self.assertRaisesRegex(WebDriverError, 'found 0'):
                self.owned_window_impl(Path('/qa/app'), '/qa/data', 'Taomni QA')


class NativePointerActionsTest(TestCase):
    def setUp(self):
        self.session = Mock()
        self.session.endpoint.side_effect = lambda suffix: '/session/qa' + suffix

    def test_canvas_and_locator_clicks_use_the_same_mouse(self):
        from tauri_webdriver import NativeSession

        click_viewport_point(self.session, 589, 278, move_ms=50, hold_ms=60)
        canvas = self.session.request.call_args_list[0].args[2]['actions'][0]
        self.assertEqual(canvas['id'], MOUSE_SOURCE)
        self.assertEqual([a['type'] for a in canvas['actions']],
                         ['pointerMove', 'pointerDown', 'pause', 'pointerUp'])
        self.session.request.reset_mock()
        self.session.find.return_value = 'toolbar'
        with patch('tauri_webdriver.prepare_click_target', return_value={'x': 913, 'y': 21}):
            NativeSession.pointer_button_click(self.session, '[data-testid=toolbar]', 0)
        posts = [c.args[2] for c in self.session.request.call_args_list if c.args[1].endswith('/actions') and c.args[0] == 'POST']
        self.assertEqual(posts[0]['actions'][0]['id'], canvas['id'])

    def test_failed_input_is_released_without_replay_or_masking_the_original_error(self):
        self.session.request.side_effect = [WebDriverError('input failed'), WebDriverError('release failed')]
        with self.assertRaisesRegex(WebDriverError, 'input failed'):
            click_viewport_point(self.session, 280, 240)
        self.assertEqual([c.args[0] for c in self.session.request.call_args_list], ['POST', 'DELETE'])


class NativeClickHoverTest(TestCase):
    def setUp(self):
        self.session = Mock(deadline=None)
        self.session.endpoint.side_effect = lambda suffix: '/session/qa' + suffix
        self.origin = {'element-6066-11e4-a52e-4f735466cecf': 'button'}

    def test_scroll_during_pointer_move_is_rechecked_before_any_button_input(self):
        first, last = {'x': 696, 'y': 405}, {'x': 696, 'y': 201}
        self.session.request.side_effect = [None, {**last, 'ready': True},
                                            None, {**last, 'ready': True}]
        with patch('native_pointer.prepare_pointer_target', side_effect=[first, last]):
            self.assertEqual(prepare_click_target(self.session, self.origin), last)
        moves = [c.args[2]['actions'][0] for c in self.session.request.call_args_list
                 if c.args[1].endswith('/actions')]
        self.assertEqual([m['actions'][0]['y'] for m in moves], [405, 201])
        self.assertTrue(all(m['id'] == MOUSE_SOURCE for m in moves))
        self.assertTrue(all([a['type'] for a in m['actions']] == ['pointerMove'] for m in moves))

    def test_covering_overlay_after_hover_cannot_authorize_a_click(self):
        point = {'x': 20, 'y': 30}
        self.session.request.side_effect = [None, {**point, 'ready': False}]
        with patch('native_pointer.prepare_pointer_target', side_effect=[
                point, WebDriverError('covered target')]):
            with self.assertRaisesRegex(WebDriverError, 'covered target'):
                prepare_click_target(self.session, self.origin)

    def test_continuous_motion_keeps_one_bounded_preparation_budget(self):
        self.session.request.side_effect = [None, {'x': 1, 'y': 2, 'ready': True}]
        with patch('native_pointer.time.monotonic', side_effect=[0, 0, 6]), \
                patch('native_pointer.prepare_pointer_target', return_value={'x': 3, 'y': 4}):
            with self.assertRaisesRegex(WebDriverError, 'moved during pointer preparation'):
                prepare_click_target(self.session, self.origin)

    def test_driver_input_failure_is_never_replayed(self):
        self.session.request.side_effect = WebDriverError('pointer transport failed')
        with patch('native_pointer.prepare_pointer_target', return_value={'x': 3, 'y': 4}):
            with self.assertRaisesRegex(WebDriverError, 'pointer transport failed'):
                prepare_click_target(self.session, self.origin)
        self.session.request.assert_called_once()


class PointerGeometryTest(TestCase):
    def geometry(self, *, zoom=1, modal=False, scaled=False, covered=False):
        harness = r"""
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
const rect = {left:24, top:232, right:36, bottom:244, width:12, height:12};
const ancestor = {parentElement:null, zoom:data.zoom};
const el = {isConnected:true, parentElement:ancestor, zoom:1,
  getBoundingClientRect:()=>rect, contains:hit=>hit===el,
  closest:()=>data.modal ? ancestor : null};
const scale = data.scaled ? data.zoom : 1;
global.innerWidth=1024; global.innerHeight=768;
global.getComputedStyle=node=>({zoom:String(node.zoom)});
global.document={elementFromPoint:(x,y)=>!data.covered &&
  x>=rect.left*scale && x<rect.right*scale &&
  y>=rect.top*scale && y<rect.bottom*scale ? el : ancestor};
process.stdout.write(JSON.stringify(new Function(data.script)(el, false)));
"""
        result = subprocess.run(["node", "-e", harness], input=json.dumps({
            "script": TARGET_GEOMETRY, "zoom": zoom, "modal": modal,
            "scaled": scaled, "covered": covered,
        }), capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_normal_geometry_keeps_its_viewport_point(self):
        self.assertEqual(self.geometry()["x"], 30)
        self.assertTrue(self.geometry()["ready"])

    def test_webkit_modal_geometry_accounts_for_inherited_zoom(self):
        result = self.geometry(zoom=19 / 14, modal=True, scaled=True)
        self.assertTrue(result["ready"], result)
        self.assertEqual((result["x"], result["y"]), (40, 323))

    def test_zoomed_modal_with_correct_viewport_geometry_is_not_scaled_twice(self):
        result = self.geometry(zoom=19 / 14, modal=True)
        self.assertTrue(result["ready"], result)
        self.assertEqual((result["x"], result["y"]), (30, 238))

    def test_modal_zoom_does_not_bypass_a_covering_element(self):
        self.assertFalse(self.geometry(zoom=19 / 14, modal=True, scaled=True, covered=True)["ready"])

    def test_nonmodal_geometry_never_uses_the_webkit_dialog_correction(self):
        self.assertFalse(self.geometry(zoom=19 / 14, scaled=True)["ready"])


class NativePointerReadinessTest(TestCase):
    def setUp(self):
        self.now = 0.0
        clock = patch('native_pointer.time.monotonic', side_effect=lambda: self.now)
        sleeper = patch('native_pointer.time.sleep', side_effect=self.advance)
        clock.start()
        sleeper.start()
        self.addCleanup(clock.stop)
        self.addCleanup(sleeper.stop)
        self.session = Mock(deadline=None)
        self.session.endpoint.return_value = '/session/qa/execute/sync'
        self.origin = {'element-6066-11e4-a52e-4f735466cecf': 'row'}

    def advance(self, seconds):
        self.now += seconds

    def geometry(self, x=270, y=217, ready=True):
        return dict(x=x, y=y, width=420, height=24, ready=ready)

    def respond(self, values):
        self.session.request.side_effect = chain(values, repeat(values[-1]))

    def test_short_scroll_pause_does_not_activate_the_old_viewport_point(self):
        # Search can briefly pause its smooth scroll before another layout
        # frame reaches WebKit's compositor. Two equal samples are insufficient.
        self.session.request.side_effect = lambda *args: self.geometry(
            y=217 if self.now < 0.12 else 405)
        self.assertEqual(prepare_pointer_target(self.session, self.origin),
                         {'x': 270, 'y': 405})
        self.assertGreaterEqual(self.now, 0.4)

    def test_moving_row_must_settle_before_a_point_can_be_used(self):
        self.respond([self.geometry(y=190), self.geometry(y=204),
                      self.geometry(), self.geometry()])
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        self.assertGreaterEqual(self.session.request.call_count, 4)
        self.assertGreaterEqual(self.now, 0.4)
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))

    def test_subpixel_webkit_dimension_jitter_keeps_the_same_physical_target(self):
        first = {**self.geometry(), "width": 738.0000000000001}
        second = {**self.geometry(), "width": 738.0}
        self.session.request.side_effect = cycle([first, second])
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        self.assertGreaterEqual(self.now, 0.3)

    def test_covered_point_cannot_satisfy_stability_until_uncovered(self):
        self.respond([self.geometry(ready=False), None, self.geometry(ready=False),
                      self.geometry(), self.geometry()])
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        self.assertGreaterEqual(self.session.request.call_count, 5)

    def test_coverage_resets_an_earlier_stable_candidate(self):
        self.respond([self.geometry(), self.geometry(ready=False), None,
                      self.geometry(), self.geometry()])
        prepare_pointer_target(self.session, self.origin)
        self.assertGreaterEqual(self.session.request.call_count, 5)

    def test_layout_growth_scrolls_the_same_target_back_into_view_before_input(self):
        outside = {**self.geometry(ready=False), "outside": True}
        self.respond([self.geometry(y=190), outside, None,
                      self.geometry(), self.geometry()])
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        scroll = self.session.request.call_args_list[2]
        self.assertIn('scrollIntoView', scroll.args[2]['script'])
        self.assertEqual(scroll.args[2]['args'], [self.origin])
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))

    def test_covered_target_can_scroll_clear_of_a_sticky_header_before_input(self):
        covered = {**self.geometry(y=59, ready=False), "outside": False}
        self.respond([covered, None, self.geometry(), self.geometry()])
        self.assertEqual(prepare_pointer_target(self.session, self.origin), {'x': 270, 'y': 217})
        scroll = self.session.request.call_args_list[1]
        self.assertIn("block:'center'", scroll.args[2]['script'])
        self.assertEqual(scroll.args[2]['args'], [self.origin])

    def test_persistent_overlay_fails_without_dispatching_input(self):
        self.session.request.return_value = self.geometry(ready=False)
        with self.assertRaisesRegex(WebDriverError, 'hit-testable'):
            prepare_pointer_target(self.session, self.origin, timeout=0.12)
        self.assertAlmostEqual(self.now, 0.12)
        self.assertTrue(all(c.args[1].endswith('/execute/sync') for c in self.session.request.call_args_list))
        scrolls = [c for c in self.session.request.call_args_list if 'scrollIntoView' in c.args[2]['script']]
        self.assertEqual(len(scrolls), 1)
        self.assertEqual(scrolls[0].args[2]['args'], [self.origin])

    def test_invalid_geometry_cannot_fall_back_to_zero_or_last_point(self):
        for value in [None, {}, self.geometry(x=float('nan')), self.geometry(x=True), self.geometry(y='217')]:
            with self.subTest(value=value):
                self.session.request.return_value = value
                with self.assertRaisesRegex(WebDriverError, 'invalid native pointer'):
                    prepare_pointer_target(self.session, self.origin)

    def test_expired_case_budget_prevents_even_preparation(self):
        self.session.deadline = Deadline(-1)
        with self.assertRaises(CaseTimeout):
            prepare_pointer_target(self.session, self.origin)
        self.session.request.assert_not_called()

    def test_stale_node_is_reported_to_the_preparation_owner(self):
        self.session.request.side_effect = WebDriverError('stale element reference')
        with self.assertRaisesRegex(WebDriverError, 'stale element'):
            prepare_pointer_target(self.session, self.origin)
        self.session.request.assert_called_once()

    def test_visible_alternate_point_is_stable_and_only_enabled_explicitly(self):
        self.session.request.return_value = self.geometry(x=68)
        self.assertEqual(prepare_pointer_target(self.session, self.origin, allow_alternate=True),
                         {'x': 68, 'y': 217})
        self.assertTrue(all(c.args[2]['args'] == [self.origin, True] for c in self.session.request.call_args_list))
        self.session.request.reset_mock()
        prepare_pointer_target(self.session, self.origin)
        self.assertTrue(all(c.args[2]['args'] == [self.origin, False] for c in self.session.request.call_args_list))
