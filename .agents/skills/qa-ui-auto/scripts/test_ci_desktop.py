import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from ci_desktop import Desktop, wayland_has_input
from ci_wayland_input import activate_window, owned_window_pid


WAYLAND_PROTOCOLS = "wl_compositor xdg_wm_base wl_output\ninterface: 'wl_seat', version: 10, name: 16\n\tname: seat0\n\tcapabilities: pointer keyboard\n"


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
             patch.object(Desktop, '_wait', side_effect=[None, None, None, WAYLAND_PROTOCOLS]) as wait, \
             patch('ci_desktop.subprocess.run') as run, \
             patch('ci_desktop.subprocess.check_output', side_effect=[
                 'GdkWaylandDisplay\n1\n', portal, 'GNOME Shell 50']):
            activation_env = {}
            started = []

            def activate(command, **kwargs):
                self.assertEqual(command[0], 'dbus-update-activation-environment')
                activation_env.update({key: os.environ[key] for key in command[1:]})

            def launch(command, **kwargs):
                if command[0] == 'gnome-shell':
                    # Shell may activate the portal before the explicit probe:
                    # that process must inherit the Wayland/PipeWire session.
                    self.assertEqual(activation_env['XDG_CURRENT_DESKTOP'], 'ubuntu:GNOME')
                    self.assertEqual(activation_env['GDK_BACKEND'], 'wayland')
                    self.assertEqual(activation_env['XDG_RUNTIME_DIR'], os.environ['XDG_RUNTIME_DIR'])
                    self.assertIn('pipewire', started)
                    self.assertIn('--unsafe-mode', command)
                started.append(command[0])
                return Mock()

            run.side_effect = activate
            start.side_effect = launch
            with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland') as desktop:
                self.assertNotIn('DISPLAY', os.environ)
                self.assertEqual(os.environ['GDK_BACKEND'], 'wayland')
                self.assertEqual(desktop.facts['gdk_display'], 'GdkWaylandDisplay')
                self.assertEqual(desktop.facts['session_type'], 'wayland')
                self.assertEqual(desktop.facts['input_devices'], ['keyboard', 'pointer'])
                self.assertEqual(desktop.facts['portal_interfaces'], ['Screenshot', 'ScreenCast', 'RemoteDesktop'])
                self.assertTrue(desktop.facts['ready'])
                self.assertEqual([call.args[2] for call in wait.call_args_list], [
                    'PipeWire', 'GNOME Wayland compositor', 'Mutter RemoteDesktop service',
                    'Wayland keyboard and pointer',
                ])
                self.assertFalse(any('openbox' in call.args[0] for call in start.call_args_list))
            self.assertEqual(os.environ['DISPLAY'], ':99')

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
            calls.append(command)
            process = Mock()
            process.poll.return_value = None
            return process

        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '26.04'}), \
             patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch.object(Desktop, 'start', side_effect=launch), patch('ci_desktop.Path.is_socket', return_value=True), \
             patch('ci_desktop.subprocess.run'), patch('ci_desktop.time.sleep'), \
             patch('ci_desktop.subprocess.check_output', side_effect=probe):
            with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland') as desktop:
                self.assertTrue(desktop.facts['ready'])
            self.assertTrue(any(command[0] == '/usr/bin/python3' for command in calls))

    def test_old_x11_profile_preserves_uncomposited_desktop(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system', return_value='Linux'), \
             patch('ci_desktop.platform.freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '22.04'}), \
             patch.dict(os.environ, {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'test-bus'}), \
             patch('ci_desktop.subprocess.check_output', side_effect=['XTEST', 'window id # 1']), \
             patch('ci_desktop.subprocess.run'), patch.object(Desktop, 'start') as start:
            with Desktop(Path(d), ['display'], 'ubuntu-22.04-x11') as desktop:
                self.assertEqual(desktop.facts['compositor'], 'none')
                self.assertEqual(desktop.facts['desktop'], 'LXQt/Openbox')
            self.assertEqual([call.args[0] for call in start.call_args_list], [['lxqt-session']])
