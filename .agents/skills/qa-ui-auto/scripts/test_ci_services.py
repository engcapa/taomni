"""Failure cleanup and credential boundaries in hosted service provisioning."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from ci_services import VNC_FIXTURE_PACKAGES, Services, install, jump_target_endpoint, sshd_forwarding_policy
from qa_ui_auto.__main__ import main


class HostedServicesTest(unittest.TestCase):
    def test_jump_target_endpoint_uses_container_port_on_linux(self):
        self.assertEqual(jump_target_endpoint("Linux", 32768), ("127.0.0.1", 2222))

    def test_jump_target_endpoint_uses_host_port_on_macos_and_windows(self):
        self.assertEqual(jump_target_endpoint("Darwin", 32768), ("127.0.0.1", 32768))
        self.assertEqual(jump_target_endpoint("Windows", 32768), ("127.0.0.1", 32768))

    def test_linux_ssh_fixture_mounts_tcp_forwarding_policy(self):
        with tempfile.TemporaryDirectory() as directory, patch("ci_services.command", side_effect=["container-id", "127.0.0.1:32768"]) as run:
            config, target = sshd_forwarding_policy(Path(directory))
            service = Services(Path(directory), ["ssh"], {})
            port = service.docker("sshd", "linuxserver/openssh-server:test", 2222,
                                  {"USER_NAME": "testuser"}, volumes=[(config, target)])
            self.assertEqual(config.read_text(encoding="utf-8"), "AllowTcpForwarding yes\nPermitOpen any\n")
            self.assertEqual(port, 32768)
            self.assertIn(f"{config}:{target}", run.call_args_list[0].args[0])


    def test_browser_sftp_fixture_resolves_shell_path_after_setup(self):
        from qa_ui_auto.runner import _run_browser_case
        with tempfile.TemporaryDirectory() as directory:
            browser = Mock()
            browser.pages = [Mock()]
            observed = []
            case = {"id": "TC-probe", "title": "SFTP path", "tags": [], "covers": [],
                    "modes": ["browser"], "fixtures": ["sftp_required"],
                    "steps": [{"open": "${fixture.sftp_shell_test_dir}"},
                              {"open": "${fixture.sftp_sync_test_dir}"},
                              {"open": "${fixture.sftp_chmod_mode}"},
                              {"open": "${fixture.sftp_chmod_status}"}]}
            cfg = {"app": {"base_url": "http://localhost"},
                   "sftp": {"host": "127.0.0.1", "port": 22,
                            "remote_test_dir": "C:/qa-temp", "remote_shell_test_dir": "/c/qa-temp",
                            "chmod_readback_mode": "644"}}
            with patch('qa_ui_auto.runner._browser_context', return_value=browser), \
                 patch('qa_ui_auto.fixtures.sftp_required.socket.create_connection'), \
                 patch('qa_ui_auto.fixtures.sftp_required.platform.system', return_value='Windows'), \
                 patch.dict('qa_ui_auto.runner.STEP_REGISTRY', {'open': lambda ctx, args: observed.append(args)}):
                result = _run_browser_case({"case": case, "cfg": cfg, "env": {}, "report_root": directory, "worker_id": 0})
            self.assertEqual(result['status'], 'passed', result)
            self.assertEqual(observed, ['/c/qa-temp', '/C:/qa-temp', '644',
                                        'chmod failed: remote server ignored requested permissions'])

    def test_teardown_failure_is_reported_without_failing_the_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Services(Path(directory), [], {})
            finished = []

            def failing():
                raise RuntimeError("pwsh.exe failed (1); ")

            service.cleanup_action("sshd-stop", failing)
            service.cleanup_action("marker", lambda: finished.append("done"))
            with patch("builtins.print") as printed:
                service.__exit__(None, None, None)
            self.assertEqual(finished, ["done"])
            messages = [str(call.args[0]) for call in printed.call_args_list if call.args]
            self.assertTrue(
                any("service cleanup (sshd-stop)" in message for message in messages),
                messages,
            )

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

    def test_vnc_fixture_is_provisioned_without_account_setup(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'GITHUB_ACTIONS': ''}), \
                patch('ci_services.platform.system', return_value='Windows'), \
                patch('ci_services.rfb_probe', return_value=(1280, 720, 'taomni-vnc-fixture')) as probe, \
                patch('ci_services.vnc_control', return_value=['[]']):
            config = {}
            service = Services(Path(directory), ['vnc'], config)
            process = Mock()
            process.poll.return_value = None
            with patch.object(service, 'start_process', return_value=process) as start:
                with service:
                    password = os.environ['QA_VNC_PASSWORD']
            argv = [str(a) for a in start.call_args.args[0]]
            self.assertEqual(argv[argv.index('--password-env') + 1], 'QA_VNC_PASSWORD')
            self.assertNotIn(password, argv)
            self.assertEqual(len(password), 8)
            self.assertEqual(probe.call_args.args[1], password)
            self.assertEqual(config['vnc']['password'], '${env.QA_VNC_PASSWORD}')
            self.assertEqual(set(config['vnc']), {'host', 'port', 'password', 'control_port'})
            lease = json.loads((Path(directory) / 'lease.json').read_text(encoding='utf-8'))
            self.assertEqual(lease['vnc']['server_init'], [1280, 720, 'taomni-vnc-fixture'])
            self.assertNotIn(password, json.dumps(lease))

    def test_screen_sharing_logs_in_a_disposable_admin_account_on_macos(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'GITHUB_ACTIONS': 'true', 'USER': 'runner'}), \
                patch('ci_services.platform.system', return_value='Darwin'), \
                patch('ci_services.command') as run, \
                patch('ci_services.subprocess.run') as best_effort, \
                patch('ci_services.ard_probe', return_value=('RFB 003.889', [30, 33, 36, 35], 1920, 1080)) as probe:
            config = {}
            with Services(Path(directory), ['ard'], config):
                password = os.environ['QA_ARD_PASSWORD']
            calls = [call.args[0] for call in run.call_args_list]
            # The SecureToken console account is never touched.
            self.assertFalse([argv for argv in calls if 'dscl' in argv or 'runner' in argv])
            self.assertIn(['sudo', '-n', 'sysadminctl', '-addUser', 'qaard', '-fullName', 'Taomni QA ARD',
                           '-password', password, '-admin'], calls)
            self.assertIn(['sudo', '-n', 'launchctl', 'enable', 'system/com.apple.screensharing'], calls)
            # Cleanup stops Screen Sharing before deleting the account.
            self.assertLess(calls.index(['sudo', '-n', 'launchctl', 'bootout', 'system/com.apple.screensharing']),
                            calls.index(['sudo', '-n', 'sysadminctl', '-deleteUser', 'qaard']))
            self.assertIn('/System/Library/LaunchDaemons/com.apple.screensharing.plist',
                          [call.args[0][-1] for call in best_effort.call_args_list])
            self.assertEqual(probe.call_args.args, (5900, 'qaard', password))
            # The probe's login session is ended before the desktop is used.
            self.assertIn(['sudo', '-n', 'pkill', '-KILL', '-u', 'qaard'],
                          [call.args[0] for call in best_effort.call_args_list])
            self.assertTrue((Path(directory) / 'screensharing-sessions.txt').is_file())
            self.assertEqual(config['ard'], {'host': '127.0.0.1', 'port': 5900, 'user': 'qaard',
                                             'password': '${env.QA_ARD_PASSWORD}', 'end_session': True})
            lease = (Path(directory) / 'lease.json').read_text(encoding='utf-8')
            self.assertIn('RFB 003.889', lease)
            self.assertNotIn(password, lease)

    def test_screen_sharing_failure_is_left_to_the_ard_cases(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}), \
                patch('ci_services.platform.system', return_value='Darwin'), \
                patch('ci_services.command'), \
                patch('ci_services.subprocess.run'), \
                patch('ci_services.retry', side_effect=RuntimeError('service protocol readiness timed out')):
            config = {}
            with Services(Path(directory), ['ard'], config):
                self.assertEqual(config['ard'], {'unavailable': 'RuntimeError: service protocol readiness timed out'})
            self.assertTrue((Path(directory) / 'screensharing-diagnostics.txt').is_file())
            lease = json.loads((Path(directory) / 'lease.json').read_text(encoding='utf-8'))
            self.assertFalse(lease['ard']['authentication'])

    def test_screen_sharing_needs_a_macos_runner(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}), \
                patch('ci_services.platform.system', return_value='Linux'):
            with self.assertRaisesRegex(RuntimeError, 'macOS runner'):
                Services(Path(directory), ['ard'], {}).__enter__()

    def test_vnc_packages_install_only_for_the_vnc_capability(self):
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}), \
                patch('ci_services.platform.system', return_value='Linux'), \
                patch('ci_services.command') as execute:
            install(['ssh'])
            self.assertFalse(any('pip' in call.args[0] for call in execute.call_args_list))
            install(['vnc'])
            pip = next(call.args[0] for call in execute.call_args_list if 'pip' in call.args[0])
            self.assertEqual(pip[-2:], VNC_FIXTURE_PACKAGES)
            self.assertTrue(all('==' in package for package in VNC_FIXTURE_PACKAGES))

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


# RFC 2409 Oakley group 2, the 1024-bit modulus macOS Screen Sharing uses.
OAKLEY_GROUP_2 = int(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74"
    "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437"
    "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF", 16)


@unittest.skipUnless(shutil.which("openssl"), "the ARD probe encrypts with the openssl CLI")
class ArdProbeTest(unittest.TestCase):
    def serve(self, listener, result):
        """macOS-like server half: RFB 003.889, ARD offered, credentials checked."""
        from ci_services import aes128_ecb, exact
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(10)
            connection.sendall(b"RFB 003.889\n")
            result["version"] = exact(connection, 12)
            connection.sendall(bytes([2, 30, 2]))
            result["chosen"] = exact(connection, 1)[0]
            private = 0x1234_5678_9ABC_DEF1
            public = pow(2, private, OAKLEY_GROUP_2)
            connection.sendall(struct.pack(">HH", 2, 128) + OAKLEY_GROUP_2.to_bytes(128, "big")
                               + public.to_bytes(128, "big"))
            credentials = exact(connection, 128)
            client_public = int.from_bytes(exact(connection, 128), "big")
            shared = pow(client_public, private, OAKLEY_GROUP_2).to_bytes(128, "big")
            plain = aes128_ecb(hashlib.md5(shared).digest(), credentials, decrypt=True)
            result["user"] = plain[:64].split(b"\0")[0].decode()
            result["password"] = plain[64:].split(b"\0")[0].decode()
            ok = result["user"] == "qaard" and result["password"] == "Qa1-pässwörd"
            connection.sendall(struct.pack(">I", 0 if ok else 1))
            if ok:
                exact(connection, 1)
                connection.sendall(struct.pack(">HH", 1920, 1080) + bytes(16) + struct.pack(">I", 3) + b"mac")

    def test_probe_logs_in_with_ard(self):
        from ci_services import ard_probe
        listener = socket.create_server(("127.0.0.1", 0))
        result = {}
        server = threading.Thread(target=self.serve, args=(listener, result))
        server.start()
        try:
            probed = ard_probe(listener.getsockname()[1], "qaard", "Qa1-pässwörd")
        finally:
            server.join(10)
            listener.close()
        self.assertEqual(probed, ("RFB 003.889", [30, 2], 1920, 1080))
        self.assertEqual(result["version"], b"RFB 003.008\n")
        self.assertEqual(result["chosen"], 30)
        self.assertEqual((result["user"], result["password"]), ("qaard", "Qa1-pässwörd"))


if __name__ == '__main__':
    unittest.main()
