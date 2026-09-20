import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from ci_desktop import Desktop


class DesktopTests(unittest.TestCase):
    def test_missing_bus_fails_before_starting_window_manager(self):
        with tempfile.TemporaryDirectory() as d, patch('ci_desktop.platform.system',return_value='Linux'), \
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
