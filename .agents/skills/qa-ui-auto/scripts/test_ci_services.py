"""Failure cleanup and credential boundaries in hosted service provisioning."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from ci_services import Services, install
from qa_ui_auto.__main__ import main


class HostedServicesTest(unittest.TestCase):
    def test_browser_sftp_fixture_resolves_shell_path_after_setup(self):
        from qa_ui_auto.runner import _run_browser_case
        with tempfile.TemporaryDirectory() as directory:
            browser = Mock()
            browser.pages = [Mock()]
            observed = []
            case = {"id": "TC-probe", "title": "SFTP path", "tags": [], "covers": [],
                    "modes": ["browser"], "fixtures": ["sftp_required"],
                    "steps": [{"open": "${fixture.sftp_shell_test_dir}"}]}
            cfg = {"app": {"base_url": "http://localhost"},
                   "sftp": {"host": "127.0.0.1", "port": 22,
                            "remote_test_dir": "C:/qa-temp", "remote_shell_test_dir": "/c/qa-temp"}}
            with patch('qa_ui_auto.runner._browser_context', return_value=browser), \
                 patch('qa_ui_auto.fixtures.sftp_required.socket.create_connection'), \
                 patch.dict('qa_ui_auto.runner.STEP_REGISTRY', {'open': lambda ctx, args: observed.append(args)}):
                result = _run_browser_case({"case": case, "cfg": cfg, "env": {}, "report_root": directory, "worker_id": 0})
            self.assertEqual(result['status'], 'passed', result)
            self.assertEqual(observed, ['/c/qa-temp'])

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

    def test_credentials_are_redacted_before_receipts_including_browser_trace(self):
        import zipfile
        from qa_ui_auto.report_secrets import redact_report
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'QA_SSH_PASSWORD': 'secret-value'}):
            root = Path(directory)
            (root / 'summary.json').write_text('{"failure":"secret-value"}')
            with zipfile.ZipFile(root / 'trace.zip', 'w') as trace:
                trace.writestr('trace.trace', '{"fill":"secret-value"}')
            redact_report(root)
            self.assertNotIn('secret-value', (root / 'summary.json').read_text())
            with zipfile.ZipFile(root / 'trace.zip') as trace:
                self.assertNotIn(b'secret-value', trace.read('trace.trace'))

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
