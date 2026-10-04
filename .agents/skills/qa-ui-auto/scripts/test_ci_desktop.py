import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from ci_desktop import Desktop


class DesktopTests(unittest.TestCase):
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
            parent=Mock(); parent.attach_mock(first,'first'); parent.attach_mock(second,'second')
            desktop.processes=[first,second]
            desktop.__exit__(None,None,None)
            names=[c[0] for c in parent.mock_calls]
            self.assertLess(names.index('second.terminate'),names.index('first.terminate'))
