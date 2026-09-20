"""Failure cleanup and credential boundaries in hosted service provisioning."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ci_services import Services, install
from qa_ui_auto.__main__ import main


class HostedServicesTest(unittest.TestCase):
    def test_partial_provisioning_failure_releases_owned_resources(self):
        with tempfile.TemporaryDirectory() as directory, patch('ci_services.platform.system', return_value='Linux'):
            service = Services(Path(directory), ['ssh', 'mysql'], {})
            cleaned = []
            def ssh():
                service.stack.callback(cleaned.append, 'ssh')
                return {'ready': True}
            with patch.object(service, 'ssh', side_effect=ssh), patch.object(service, 'mysql', side_effect=RuntimeError('DML failed')):
                with self.assertRaisesRegex(RuntimeError, 'DML'):
                    service.__enter__()
            self.assertEqual(cleaned, ['ssh'])
            self.assertFalse(service.private.exists())

    def test_package_install_is_never_implicit_on_developer_host(self):
        with patch.dict('os.environ', {'GITHUB_ACTIONS': ''}), patch('ci_services.command') as execute:
            with self.assertRaisesRegex(RuntimeError, 'restricted'):
                install(['ssh', 'mysql'])
            execute.assert_not_called()

    def test_manifest_mode_is_not_overridden_by_cli_browser_default(self):
        with patch('qa_ui_auto.runner.main', return_value=0) as run:
            main(['run', '--selection', 'selection.json', '--selection-entry', 'linux-native'])
            self.assertNotIn('--mode', run.call_args.args[0])
            main(['run', '--filter', 'TC-001'])
            self.assertEqual(run.call_args.args[0][-2:], ['--mode', 'browser'])


if __name__ == '__main__':
    unittest.main()
