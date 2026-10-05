import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from ci_desktop import Desktop


class DesktopTests(unittest.TestCase):
    def setUp(self):
        release = patch('ci_desktop.platform.freedesktop_os_release',
                        return_value={'ID': 'ubuntu', 'VERSION_ID': '24.04'})
        release.start()
        self.addCleanup(release.stop)

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
             patch.object(Desktop, 'start'), patch.object(Desktop, '_wait'), \
             patch('ci_desktop.subprocess.run'), \
             patch('ci_desktop.subprocess.check_output', side_effect=['wl_compositor xdg_wm_base wl_output', 'GdkX11Display\n1\n']):
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
             patch.object(Desktop, 'start') as start, patch.object(Desktop, '_wait'), \
             patch('ci_desktop.subprocess.run') as run, \
             patch('ci_desktop.subprocess.check_output', side_effect=[
                 'wl_compositor xdg_wm_base wl_output', 'GdkWaylandDisplay\n1\n', portal, 'GNOME Shell 50']):
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
                started.append(command[0])
                return Mock()

            run.side_effect = activate
            start.side_effect = launch
            with Desktop(Path(d), ['display'], 'ubuntu-26.04-wayland') as desktop:
                self.assertNotIn('DISPLAY', os.environ)
                self.assertEqual(os.environ['GDK_BACKEND'], 'wayland')
                self.assertEqual(desktop.facts['gdk_display'], 'GdkWaylandDisplay')
                self.assertEqual(desktop.facts['session_type'], 'wayland')
                self.assertEqual(desktop.facts['portal_interfaces'], ['Screenshot', 'ScreenCast', 'RemoteDesktop'])
                self.assertTrue(desktop.facts['ready'])
                self.assertFalse(any('openbox' in call.args[0] for call in start.call_args_list))
            self.assertEqual(os.environ['DISPLAY'], ':99')

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
