import os
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
from ci_desktop import Desktop, wayland_has_input
from ci_wayland_input import activate_window, owned_window_pid
from qa_ui_auto.linux_ime import current_fcitx_engine


WAYLAND_PROTOCOLS = "wl_compositor xdg_wm_base wl_output\ninterface: 'wl_seat', version: 10, name: 16\n\tname: seat0\n\tcapabilities: pointer keyboard\n"
AUDIO_CLIENTS = json.dumps([{'type': 'PipeWire:Interface:Client',
                            'info': {'props': {'application.name': 'WirePlumber'}}}])


class LinuxImeTests(unittest.TestCase):
    def test_x11_activation_verifies_keyboard_focus_even_when_wm_says_active(self):
        from qa_ui_auto.native_steps import _activate_x11_application
        from qa_ui_auto.steps import StepError

        identity = f'WM_CLASS(STRING) = "Taomni QA"\n_NET_WM_PID(CARDINAL) = {os.getpid()}'
        for focus in ('2097155', '0x200003', '4194304', 'invalid'):
            with self.subTest(focus=focus), \
                 patch('qa_ui_auto.native_steps._command_output', side_effect=[
                     '_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x200003', identity,
                     '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x200003', '', focus]) as command:
                if focus in ('2097155', '0x200003'):
                    self.assertEqual(_activate_x11_application(Path(sys.executable)), ('0x200003', identity))
                else:
                    with self.assertRaisesRegex(StepError, 'keyboard focus'):
                        _activate_x11_application(Path(sys.executable))
                self.assertIn(['xdotool', 'windowfocus', '--sync', '0x200003'], [call.args[0] for call in command.call_args_list])

    def test_ime_does_not_inject_into_an_unfocused_native_document(self):
        from qa_ui_auto.native_steps import NativeStepContext, _do_native_ime_keys
        from qa_ui_auto.steps import StepError

        with tempfile.TemporaryDirectory() as d, \
             patch.dict(os.environ, {'DISPLAY': ':99'}), \
             patch('qa_ui_auto.native_steps.platform.system', return_value='Linux'), \
             patch('qa_ui_auto.native_steps.time.sleep'), \
             patch('qa_ui_auto.native_steps.time.monotonic', side_effect=[0, 4]), \
             patch('qa_ui_auto.native_steps._activate_x11_application', return_value=('0x1', 'taomni')), \
             patch('qa_ui_auto.native_steps.current_fcitx_engine') as engine, \
             patch('qa_ui_auto.native_steps._inject_x11_keys') as inject:
            session = Mock()
            # DOM activeElement can remain the editor after the native window
            # loses focus. That is insufficient evidence for physical input.
            session.execute.side_effect = [True, False]
            ctx = NativeStepContext(session, Path(d), {})
            with self.assertRaisesRegex(StepError, 'no native document focus'):
                _do_native_ime_keys(ctx, {'selector': '.cm-content', 'expected_engine': 'wbpy', 'keys': ['n']})
            engine.assert_not_called()
            inject.assert_not_called()

    def test_engine_observation_uses_the_api_available_before_remote_n(self):
        with patch('qa_ui_auto.linux_ime.subprocess.check_output', return_value="('wbpy',)\n") as call:
            self.assertEqual(current_fcitx_engine(env={'DBUS_SESSION_BUS_ADDRESS': 'qa-bus'}), 'wbpy')
            command = call.call_args.args[0]
            self.assertEqual(command[-1], 'org.fcitx.Fcitx.Controller1.CurrentInputMethod')
            self.assertEqual(call.call_args.kwargs['env'], {'DBUS_SESSION_BUS_ADDRESS': 'qa-bus'})

    def test_engine_observation_rejects_invalid_or_ambiguous_replies(self):
        for reply in ('wbpy', "('wbpy', 'pinyin')", '(42,)', "'wbpy'", '()'):
            with self.subTest(reply=reply), \
                 patch('qa_ui_auto.linux_ime.subprocess.check_output', return_value=reply):
                with self.assertRaisesRegex(RuntimeError, 'invalid fcitx5 current engine reply'):
                    current_fcitx_engine()

    def test_native_ime_checks_the_observed_engine_before_injecting_keys(self):
        from qa_ui_auto.native_steps import NativeStepContext, _do_native_ime_keys
        from qa_ui_auto.steps import StepError

        for observed_engine in ('wbpy', 'pinyin'):
            with self.subTest(observed_engine=observed_engine), tempfile.TemporaryDirectory() as d, \
                 patch.dict(os.environ, {'DISPLAY': ':99'}), \
                 patch('qa_ui_auto.native_steps.platform.system', return_value='Linux'), \
                 patch('qa_ui_auto.native_steps.platform.platform', return_value='Linux-qa'), \
                 patch('qa_ui_auto.native_steps.time.sleep'), \
                 patch('qa_ui_auto.native_steps._activate_x11_application', return_value=('0x1', 'taomni')), \
                 patch('qa_ui_auto.native_steps._command_output', side_effect=['1', '', '2']) as command, \
                 patch('qa_ui_auto.linux_ime.subprocess.check_output',
                       side_effect=["('keyboard-us',)", repr((observed_engine,))]), \
                 patch('qa_ui_auto.native_steps.subprocess.run') as restore, \
                 patch('qa_ui_auto.native_steps._inject_x11_keys') as inject:
                session = Mock()
                session.execute.return_value = True
                ctx = NativeStepContext(session, Path(d), {})
                args = {'selector': '.cm-content', 'expected_engine': 'wbpy', 'keys': ['n', 'Space']}
                if observed_engine == 'wbpy':
                    command.side_effect = ['1', '', '', '2']
                    _do_native_ime_keys(ctx, args)
                    inject.assert_called_once_with(['n', 'Space'])
                    observation = json.loads((Path(d) / 'native-ime-observation.json').read_text())
                    self.assertEqual(observation['engine'], 'wbpy')
                else:
                    with self.assertRaisesRegex(StepError, "current 'pinyin'"):
                        _do_native_ime_keys(ctx, args)
                    inject.assert_not_called()
                    self.assertFalse((Path(d) / 'native-ime-observation.json').exists())
                self.assertEqual([call.args[0] for call in restore.call_args_list], [
                    ['fcitx5-remote', '-s', 'keyboard-us'], ['fcitx5-remote', '-c']])


class DesktopTests(unittest.TestCase):
    def setUp(self):
        release = patch('ci_desktop.platform.freedesktop_os_release',
                        return_value={'ID': 'ubuntu', 'VERSION_ID': '24.04'})
        release.start()
        self.addCleanup(release.stop)

    def test_wayland_window_identity_rejects_other_executables_and_desktops(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            application = root / 'taomni-qa'
            application.touch()
            other = root / 'other-app'
            other.touch()
            for pid, executable, runtime in ((1, application, '/owned/runtime'),
                                             (2, other, '/owned/runtime'),
                                             (3, application, '/personal/runtime')):
                directory = root / str(pid)
                directory.mkdir()
                (directory / 'exe').symlink_to(executable)
                (directory / 'environ').write_bytes(f'XDG_RUNTIME_DIR={runtime}\0'.encode())
            windows = [{'pid': pid} for pid in (1, 2, 3)]
            self.assertEqual(owned_window_pid(windows, application, Path('/owned/runtime'), root), 1)
            with self.assertRaisesRegex(RuntimeError, 'found 0'):
                owned_window_pid(windows[1:], application, Path('/owned/runtime'), root)
            with self.assertRaisesRegex(RuntimeError, 'found 2'):
                owned_window_pid([windows[0], windows[0]], application, Path('/owned/runtime'), root)

    def test_wayland_activation_requires_observed_os_focus_and_retains_before_after(self):
        before = {'overview': True, 'windows': [{'pid': 42, 'focused': False}]}
        after = {'overview': False, 'windows': [{'pid': 42, 'focused': True}]}
        evaluate = Mock(side_effect=[before, True, before, after])
        diagnostics = {}
        with patch('ci_wayland_input.owned_window_pid', return_value=42), patch('ci_wayland_input.time.sleep'):
            activate_window(evaluate, Path('/qa/taomni'), Path('/owned/runtime'), diagnostics)
        self.assertEqual(diagnostics, {'pid': 42, 'before': before, 'after': after})

    def test_wayland_activation_does_not_accept_focusing_another_window(self):
        state = {'overview': False, 'windows': [{'pid': 42, 'focused': False}, {'pid': 99, 'focused': True}]}
        evaluate = Mock(side_effect=[state, True, state])
        diagnostics = {}
        with patch('ci_wayland_input.owned_window_pid', return_value=42), \
                patch('ci_wayland_input.time.monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(RuntimeError, 'did not focus'):
                activate_window(evaluate, Path('/qa/taomni'), Path('/owned/runtime'), diagnostics)
        self.assertEqual(diagnostics['after'], state)

    def test_linux_display_owns_a_compositor_for_transparent_windows(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.machine', return_value='x86_64'), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.subprocess.run'), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start') as start:
            start.return_value.poll.return_value = None
            with Desktop(Path(d), ['display']):
                facts = json.loads((Path(d) / 'desktop-readiness.json').read_text())
                self.assertEqual(facts['compositor'], 'xcompmgr')
                self.assertTrue(facts['ready'])
            self.assertEqual([c.args[0] for c in start.call_args_list],
                             [['openbox', '--sm-disable'], ['xcompmgr', '-n']])

    def test_linux_compositor_failure_is_not_reported_as_ready(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.machine', return_value='x86_64'), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.time.sleep'), patch.object(Desktop, 'start') as start:
            start.return_value.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, 'compositor exited'):
                with Desktop(Path(d), ['display']):
                    pass
            self.assertFalse((Path(d) / 'desktop-readiness.json').exists())

    def test_ime_waits_for_its_daemon_before_creating_a_gtk_context(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'qa-bus'}), \
             patch('ci_desktop.Path.is_file', return_value=True), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start') as start, patch('ci_desktop.subprocess.check_output') as owner, \
             patch('ci_desktop.subprocess.run') as remote:
            desktop = Desktop(Path(d), ['ime'])
            fcitx, gtk = Mock(pid=42), Mock()
            fcitx.poll.return_value = gtk.poll.return_value = None
            owners = iter(['(uint32 99,)', '(uint32 42,)'])
            observed_owner = None
            environments = []
            probes = iter(['keyboard-us', 'wbpy'])

            def launch(command, **kwargs):
                environments.append(kwargs['env'])
                if command[0] == 'fcitx5':
                    process = fcitx
                else:
                    self.assertEqual(observed_owner, '(uint32 42,)')
                    process = gtk
                desktop.processes.append(process)
                return process

            def get_owner(command, **kwargs):
                nonlocal observed_owner
                self.assertEqual(kwargs['env'], environments[0])
                if command[-1] == 'org.fcitx.Fcitx.Controller1.CurrentInputMethod':
                    self.assertEqual(observed_owner, '(uint32 42,)')
                    self.assertIn(gtk, desktop.processes)
                    return repr((next(probes),))
                self.assertEqual(command[-2:], ['org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.fcitx.Fcitx5'])
                observed_owner = next(owners)
                return observed_owner

            def get_engine(command, **kwargs):
                self.assertEqual(observed_owner, '(uint32 42,)')
                self.assertIn(gtk, desktop.processes)
                self.assertEqual(kwargs['env'], environments[0])
                self.assertIn(command, [
                    ['fcitx5-remote', '-s', 'wbpy'],
                    ['fcitx5-remote', '-s', 'keyboard-us'], ['fcitx5-remote', '-c']])
                return subprocess.CompletedProcess(command, 0, '')

            start.side_effect = launch
            owner.side_effect = get_owner
            remote.side_effect = get_engine
            facts = {}
            desktop._ime(facts)
            self.assertEqual(facts['ime']['observed_engine'], 'wbpy')
            self.assertEqual(facts['ime']['pid'], 42)
            self.assertEqual(environments[0], environments[1])
            self.assertEqual(owner.call_count, 4)
            self.assertEqual(remote.call_count, 4)
            self.assertEqual([call.args[0] for call in remote.call_args_list[-2:]],
                             [['fcitx5-remote', '-s', 'keyboard-us'], ['fcitx5-remote', '-c']])
            config = (desktop.root / 'ime-config/fcitx5/config').read_text()
            self.assertIn('[Hotkey/AltTriggerKeys]\n', config)
            self.assertIn('[Hotkey/TriggerKeys]\n', config)
            self.assertEqual(desktop.processes, [fcitx])
            gtk.terminate.assert_called_once()

    def test_ime_rejects_a_dbus_service_owned_by_another_daemon(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ), \
             patch('ci_desktop.Path.is_file', return_value=True), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start') as start, \
             patch('ci_desktop.subprocess.check_output', return_value='(uint32 99,)'), \
             patch('ci_desktop.subprocess.run') as remote:
            start.return_value.pid = 42
            start.return_value.poll.return_value = None
            with self.assertRaisesRegex(RuntimeError, 'QA fcitx5 DBus owner did not become ready'):
                Desktop(Path(d), ['ime'])._ime({})
            self.assertEqual(start.call_count, 1)
            remote.assert_not_called()

    def test_ime_rejects_a_ready_daemon_with_the_wrong_engine(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ), \
             patch('ci_desktop.Path.is_file', return_value=True), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start') as start, \
             patch('ci_desktop.subprocess.check_output', side_effect=lambda command, **kwargs:
                   '(uint32 42,)' if command[-1] == 'org.fcitx.Fcitx5' else "('keyboard-us',)"), \
             patch('ci_desktop.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'keyboard-us')):
            start.return_value.pid = 42
            start.return_value.poll.return_value = None
            with self.assertRaisesRegex(RuntimeError, 'fcitx5 wbpy engine did not become ready'):
                Desktop(Path(d), ['ime'])._ime({})

    def test_x11_audio_is_ready_in_the_environment_inherited_by_native_children(self):
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus',
                                     'XDG_RUNTIME_DIR': '/original/runtime', 'PULSE_SERVER': 'original-pulse'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.subprocess.run', return_value=subprocess.CompletedProcess([], 0, AUDIO_CLIENTS)), \
             patch('ci_desktop.Path.is_socket', return_value=True), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start') as start:
            start.return_value.poll.return_value = None
            with Desktop(Path(d), ['audio']) as desktop:
                runtime = Path(desktop.facts['audio']['runtime_dir'])
                self.assertNotEqual(str(runtime), '/original/runtime')
                self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
                child = real_run([sys.executable, '-c',
                    'import json,os; print(json.dumps({k:os.environ[k] for k in ("XDG_RUNTIME_DIR","PULSE_SERVER")}))'],
                    check=True, capture_output=True, text=True)
                self.assertEqual(json.loads(child.stdout), {
                    'XDG_RUNTIME_DIR': str(runtime), 'PULSE_SERVER': f'unix:{runtime}/pulse/native'})
                self.assertTrue(desktop.facts['ready'])
            self.assertFalse(runtime.exists())
            self.assertEqual(os.environ['XDG_RUNTIME_DIR'], '/original/runtime')
            self.assertEqual(os.environ['PULSE_SERVER'], 'original-pulse')
            self.assertEqual([c.args[0] for c in start.call_args_list],
                             [['openbox', '--sm-disable'], ['pipewire'], ['wireplumber'], ['pipewire-pulse']])

    def test_failed_audio_server_prevents_readiness_and_restores_the_original_runtime(self):
        processes = [Mock() for _ in range(4)]
        for process in processes:
            process.poll.return_value = None
        processes[-1].poll.return_value = 7
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus',
                                     'XDG_RUNTIME_DIR': '/original/runtime', 'PULSE_SERVER': 'original-pulse'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.subprocess.run', return_value=subprocess.CompletedProcess([], 0, AUDIO_CLIENTS)), \
             patch('ci_desktop.Path.is_socket', return_value=True), patch('ci_desktop.time.sleep'), \
             patch.object(Desktop, 'start', side_effect=processes):
            with self.assertRaisesRegex(RuntimeError, 'PipeWire Pulse server exited'):
                with Desktop(Path(d), ['audio']):
                    pass
            self.assertFalse((Path(d) / 'desktop-readiness.json').exists())
            self.assertFalse(json.loads((Path(d) / 'desktop-failure.json').read_text())['ready'])
            self.assertEqual(os.environ['XDG_RUNTIME_DIR'], '/original/runtime')
            self.assertEqual(os.environ['PULSE_SERVER'], 'original-pulse')

    def test_missing_bus_fails_before_starting_window_manager(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system',return_value='Linux'), \
             patch('ci_desktop.platform.machine',return_value='x86_64'), \
             patch.dict(os.environ,{'DISPLAY':':99','DBUS_SESSION_BUS_ADDRESS':''}), \
             patch('ci_desktop.subprocess.Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError,'DBUS_SESSION_BUS_ADDRESS'):
                with Desktop(Path(d), ['display']):
                    pass
            spawn.assert_not_called()

    def test_cleanup_stops_owned_processes_in_reverse_order(self):
        with tempfile.TemporaryDirectory() as d:
            desktop=Desktop(Path(d),[])
            first,second=Mock(),Mock()
            first.poll.return_value = second.poll.return_value = None
            parent=Mock(); parent.attach_mock(first,'first'); parent.attach_mock(second,'second')
            desktop.processes=[first,second]
            desktop.__exit__(None,None,None)
            names=[c[0] for c in parent.mock_calls]
            self.assertLess(names.index('second.terminate'),names.index('first.terminate'))

    def test_cleanup_detaches_private_document_portal_mount_before_removing_runtime(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.sys.platform', 'linux'), \
             patch('ci_desktop.Path.is_mount', return_value=True), \
             patch('ci_desktop.subprocess.run') as unmount:
            desktop = Desktop(Path(d), [], 'ubuntu-26.04-wayland')
            desktop.temporary = Mock()
            desktop.temporary.name = str(Path(d) / 'owned-runtime')
            parent = Mock()
            parent.attach_mock(unmount, 'unmount')
            parent.attach_mock(desktop.temporary.cleanup, 'remove')
            desktop.__exit__(None, None, None)
            unmount.assert_called_once_with(
                ['fusermount3', '-uz', str(Path(d) / 'owned-runtime/runtime/doc')], check=True, timeout=15)
            self.assertEqual([call[0] for call in parent.mock_calls], ['unmount', 'remove'])

    def test_cleanup_failure_restores_original_display_environment(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {'DISPLAY': ':99'}):
            desktop = Desktop(Path(d), [])
            desktop.temporary = Mock()
            desktop.temporary.name = d
            desktop.temporary.cleanup.side_effect = PermissionError('portal mount')
            os.environ['DISPLAY'] = ':100'
            with self.assertRaises(PermissionError):
                desktop.__exit__(None, None, None)
            self.assertEqual(os.environ['DISPLAY'], ':99')

    def test_profile_os_mismatch_fails_before_starting_any_desktop(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch.object(Desktop, 'start') as start:
            with self.assertRaisesRegex(RuntimeError, 'requires Ubuntu 26.04'):
                with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland'):
                    pass
            start.assert_not_called()
            self.assertFalse(json.loads((Path(d) / 'desktop-failure.json').read_text())['ready'])

    def test_wayland_rejects_gtk_x11_fallback(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '26.04'}), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch.object(Desktop, 'start'), patch.object(Desktop, '_wait', side_effect=[None, None, None, WAYLAND_PROTOCOLS]), \
             patch('ci_desktop.subprocess.run'), \
             patch('ci_desktop.subprocess.check_output', return_value='GdkX11Display\n1\n'):
            with self.assertRaisesRegex(RuntimeError, 'GTK did not use a Wayland display'):
                with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland'):
                    pass
            self.assertEqual(os.environ['DISPLAY'], ':99')
            self.assertFalse((Path(d) / 'desktop-readiness.json').exists())

    def test_wayland_records_protocol_portal_and_backend_identity(self):
        portal = '\n'.join('org.freedesktop.portal.' + name for name in ('Screenshot', 'ScreenCast', 'RemoteDesktop'))
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '26.04'}), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch.object(Desktop, 'start') as start, \
             patch.object(Desktop, '_wait', side_effect=[None, None, None, WAYLAND_PROTOCOLS, ':42', d + '/xauth', True]) as wait, \
             patch('ci_desktop.subprocess.run') as run, \
             patch('ci_desktop.subprocess.check_output', side_effect=[
                 'GdkWaylandDisplay\n1\n', portal, 'GNOME Shell 50']):
            activation_env = {}
            (Path(d) / 'xauth').touch()
            started = []
            accessibility_enabled = []

            def activate(command, **kwargs):
                if command[0] == 'dbus-update-activation-environment':
                    activation_env.update({key: os.environ[key] for key in command[1:]})
                else:
                    self.assertEqual(command, [
                        'gdbus', 'call', '--session', '--dest', 'org.a11y.Bus',
                        '--object-path', '/org/a11y/bus', '--method',
                        'org.freedesktop.DBus.Properties.Set', 'org.a11y.Status',
                        'IsEnabled', '<true>',
                    ])
                    self.assertEqual(activation_env['GTK_A11Y'], 'atspi')
                    self.assertEqual(activation_env['NO_AT_BRIDGE'], '0')
                    accessibility_enabled.append(True)
                return Mock(returncode=0)

            def launch(command, **kwargs):
                if command[0] == 'gnome-shell':
                    # Shell may activate the portal before the explicit probe:
                    # that process must inherit the Wayland/PipeWire session.
                    self.assertEqual(activation_env['XDG_CURRENT_DESKTOP'], 'ubuntu:GNOME')
                    self.assertEqual(activation_env['GDK_BACKEND'], 'wayland')
                    self.assertEqual(activation_env['XDG_RUNTIME_DIR'], os.environ['XDG_RUNTIME_DIR'])
                    data = Path(activation_env['XDG_RUNTIME_DIR']).parent / 'data'
                    self.assertTrue(activation_env['XDG_DATA_DIRS'].startswith(str(data) + ':'))
                    entry = data / 'applications/com.taomni.app.qa.desktop'
                    self.assertFalse(entry.exists())
                    self.assertEqual(accessibility_enabled, [True])
                    self.assertIn('pipewire', started)
                    self.assertIn('--unsafe-mode', command)
                    self.assertIn('--mode=user', command)
                started.append(command[0])
                return Mock()

            run.side_effect = activate
            start.side_effect = launch
            with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland') as desktop:
                self.assertEqual(os.environ['DISPLAY'], ':42')
                self.assertEqual(os.environ['XAUTHORITY'], d + '/xauth')
                self.assertEqual(os.environ['GDK_BACKEND'], 'wayland')
                self.assertEqual(desktop.facts['gdk_display'], 'GdkWaylandDisplay')
                self.assertEqual(desktop.facts['session_type'], 'wayland')
                self.assertEqual(desktop.facts['shell_session_mode'], 'user')
                self.assertEqual(desktop.facts['input_devices'], ['keyboard', 'pointer'])
                self.assertEqual(desktop.facts['portal_interfaces'], ['Screenshot', 'ScreenCast', 'RemoteDesktop'])
                self.assertTrue(desktop.facts['ready'])
                self.assertEqual(desktop.facts['portal_application']['verification'], 'awaiting-build')
                self.assertEqual([call.args[2] for call in wait.call_args_list], [
                    'PipeWire', 'GNOME Wayland compositor', 'Mutter RemoteDesktop service',
                    'Wayland keyboard and pointer',
                    'owned XWayland workload display', 'owned XWayland authentication',
                    'GNOME portal accessibility automation',
                ])
                self.assertFalse(any('openbox' in call.args[0] for call in start.call_args_list))
            self.assertEqual(os.environ['DISPLAY'], ':99')
            self.assertFalse(Path(desktop.facts['portal_application']['desktop_file']).exists())

    def test_wayland_protocol_globals_with_an_empty_seat_are_not_input_ready(self):
        self.assertFalse(wayland_has_input(WAYLAND_PROTOCOLS.replace('pointer keyboard', '')))
        self.assertFalse(wayland_has_input(WAYLAND_PROTOCOLS.replace('pointer keyboard', 'pointer')))
        self.assertFalse(wayland_has_input(WAYLAND_PROTOCOLS.replace('pointer keyboard', 'keyboard')))
        self.assertTrue(wayland_has_input(WAYLAND_PROTOCOLS))

    def test_wayland_missing_keyboard_fails_before_gtk_backend_probe(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '26.04'}), \
             patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch.object(Desktop, 'start') as start, patch('ci_desktop.Path.is_socket', return_value=True), \
             patch('ci_desktop.subprocess.run'), patch('ci_desktop.time.sleep'), \
             patch('ci_desktop.subprocess.check_output', side_effect=lambda cmd, **kw:
                   WAYLAND_PROTOCOLS.replace('pointer keyboard', '') if cmd == ['wayland-info'] else '(true,)') as probe:
            start.return_value.poll.return_value = None
            with self.assertRaisesRegex(RuntimeError, 'Wayland keyboard and pointer did not become ready'):
                with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland'):
                    pass
            self.assertEqual(probe.call_args_list[0].args[0][0], 'gdbus')
            self.assertTrue(all(call.args[0] == ['wayland-info'] for call in probe.call_args_list[1:]))
            self.assertFalse((Path(d) / 'desktop-readiness.json').exists())

    def test_wayland_waits_for_mutter_dbus_owner_after_its_socket_appears(self):
        calls = []
        owner_checks = []
        portal = '\n'.join('org.freedesktop.portal.' + name for name in ('Screenshot', 'ScreenCast', 'RemoteDesktop'))

        def probe(command, **kwargs):
            if command[-1] == 'org.gnome.Mutter.RemoteDesktop':
                owner_checks.append(command)
                return '(false,)' if len(owner_checks) == 1 else '(true,)'
            if command == ['wayland-info']:
                return WAYLAND_PROTOCOLS
            if command[0] == '/usr/bin/python3':
                return 'GdkWaylandDisplay\n1\n'
            if command[0] == 'gdbus':
                return portal
            return 'GNOME Shell 50'

        def launch(command, **kwargs):
            if command[0] == '/usr/bin/python3':
                self.assertEqual(len(owner_checks), 2)
                if '--ready' in command:
                    Path(command[command.index('--ready') + 1]).write_text('{}')
            calls.append(command)
            process = Mock()
            process.poll.return_value = None
            return process

        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '26.04'}), \
             patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch.object(Desktop, 'start', side_effect=launch), patch('ci_desktop.Path.is_socket', return_value=True), \
             patch('qa_ui_auto.wayland.command', side_effect=lambda name: ':42' if name == 'xwayland_display' else d + '/xauth'), \
             patch('ci_desktop.subprocess.run'), patch('ci_desktop.time.sleep'), \
             patch('ci_desktop.subprocess.check_output', side_effect=probe):
            (Path(d) / 'xauth').touch()
            with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland') as desktop:
                self.assertTrue(desktop.facts['ready'])
            self.assertTrue(any(command[0] == '/usr/bin/python3' for command in calls))

    def test_ubuntu_22_x11_profile_owns_a_compositor_for_transparent_windows(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '22.04'}), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.subprocess.run'), patch.object(Desktop, 'start') as start:
            start.return_value.poll.return_value = None
            with Desktop(Path(d), ['display'], 'ubuntu-22.04-x11') as desktop:
                self.assertEqual(desktop.facts['compositor'], 'xcompmgr')
                self.assertEqual(desktop.facts['desktop'], 'LXQt/Openbox')
                config = Path(desktop.temporary.name) / 'config'
                for name in ('xscreensaver.desktop', 'lxqt-powermanagement.desktop'):
                    self.assertIn('Hidden=true', (config / 'autostart' / name).read_text())
                self.assertFalse(desktop.facts['idle_blanking'])
            self.assertEqual([call.args[0] for call in start.call_args_list], [['lxqt-session'], ['xcompmgr', '-n']])
