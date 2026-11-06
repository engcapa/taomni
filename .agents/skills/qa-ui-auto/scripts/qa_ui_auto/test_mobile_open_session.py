"""Host-only tests for the phone-open oracle; these do not prove native behavior."""
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from . import mobile_open_session as probe
from .fixtures import mobile_service
from .steps import StepError


class PtyReceiptTest(TestCase):
    def test_shell_command_writes_exact_marker_with_quoted_path_and_separate_stdout(self):
        with tempfile.TemporaryDirectory(prefix="mobile open ' ") as folder:
            path = Path(folder) / "PTY marker's receipt.txt"
            command = probe.marker_command(path, 'QA_DISK_NONCE', 'QA_STDOUT_NONCE')
            result = subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', command.removesuffix('\r')],
                                    cwd='/', capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(path.read_bytes(), b'QA_DISK_NONCE\n')
            self.assertEqual(result.stdout, 'QA_STDOUT_NONCE\n')
            self.assertEqual(result.stderr, '')

    def test_echo_does_not_count_as_output_and_shell_control_sequences_are_ignored(self):
        marker = 'QA_STDOUT_NONCE'
        echo = "host$ printf '%s\\n' " + marker + '\r\n'
        self.assertFalse(probe.output_line(echo, marker))
        self.assertFalse(probe.output_line(echo + marker + '_extra\r\n', marker))
        self.assertTrue(probe.output_line(echo + '\x1b]633;C\x07\x1b[32m' + marker + '\x1b[0m\r\n', marker))
        self.assertTrue(probe.output_line('\x1b]0;shell\x1b\\' + marker + '\r\n', marker))

    def test_preexisting_marker_is_not_accepted_as_a_pty_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(case_dir=Path(folder))
            (ctx.case_dir / 'mobile-open-local-marker.txt').write_text('stale')
            with patch.object(probe, 'Ws') as ws:
                with self.assertRaisesRegex(StepError, 'already exists'):
                    probe.exercise_pty(ctx, 'http://127.0.0.1:1', 'device', 'token', 'term:key', {}, 'local', {})
            ws.assert_not_called()


class OpenRequestTest(TestCase):
    def test_pending_to_opened_records_owner_polls_and_denies_other_device(self):
        record = {}
        replies = [(200, {}, {'request_id': 'request', 'status': 'pending'}),
                   (404, {}, {'error': 'open_request_not_found'}),
                   (200, {}, {'request_id': 'request', 'status': 'pending'}),
                   (200, {}, {'request_id': 'request', 'status': 'opened', 'session_id': 'term:new-key'})]
        with patch.object(probe, 'http', side_effect=replies) as http, patch.object(probe.time, 'sleep'):
            session = probe.open_request('http://127.0.0.1:1', 'owner-secret', 'outsider-secret', {'kind': 'local'}, record)
        self.assertEqual(session, 'term:new-key')
        self.assertEqual(http.call_count, 4)
        self.assertEqual(http.call_args_list[1].args[2], 'outsider-secret')
        self.assertEqual([row['response']['status'] for row in record['polls']], ['pending', 'opened'])
        self.assertNotIn('secret', json.dumps(record))

    def test_another_device_reading_the_request_is_a_failure(self):
        replies = [(200, {}, {'request_id': 'request', 'status': 'pending'}),
                   (200, {}, {'request_id': 'request', 'status': 'opened', 'session_id': 'term:key'})]
        with patch.object(probe, 'http', side_effect=replies):
            with self.assertRaisesRegex(StepError, 'another device could poll'):
                probe.open_request('endpoint', 'owner', 'outsider', {'kind': 'local'}, {})

    def test_failed_desktop_result_stops_without_a_second_open_attempt(self):
        replies = [(200, {}, {'request_id': 'request', 'status': 'pending'}),
                   (404, {}, {'error': 'open_request_not_found'}),
                   (200, {}, {'request_id': 'request', 'status': 'failed', 'error': 'open_failed'})]
        record = {}
        with patch.object(probe, 'http', side_effect=replies) as http:
            with self.assertRaisesRegex(StepError, 'desktop open failed'):
                probe.open_request('endpoint', 'owner', 'outsider', {'kind': 'local'}, record)
        self.assertEqual(http.call_count, 3)
        self.assertEqual(record['polls'][-1]['response']['error'], 'open_failed')

    def test_original_failure_keeps_a_false_receipt_and_the_observed_phase(self):
        initial = {'sessions': [], 'saved_sessions': [], 'capabilities': {'open_sessions': True}}
        with tempfile.TemporaryDirectory() as folder:
            session = Mock()
            session.execute.return_value = {'tabs': [], 'terminals': []}
            ctx = SimpleNamespace(case_dir=Path(folder), session=session)
            with patch.object(probe, 'sessions', return_value=initial):
                with self.assertRaisesRegex(StepError, 'not disabled by default'):
                    probe.run(ctx, 'endpoint', ('owner', 'owner-secret'), ('other', 'other-secret'))
            record = json.loads((ctx.case_dir / 'mobile-open-session-receipt.json').read_text())
            self.assertFalse(record['passed'])
            self.assertEqual(record['phase'], 'disabled')
            self.assertIn('not disabled by default', record['failure']['message'])
            self.assertNotIn('secret', json.dumps(record))
            session.click.assert_not_called()


class FixtureCompatibilityTest(TestCase):
    def test_existing_cases_keep_the_same_saved_session_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(case_id='TC-MOBILE-002', case_dir=Path(folder), values={})
            with patch.object(mobile_service, 'seed_sessions') as seed:
                mobile_service.setup(ctx)
            self.assertEqual([row['id'] for row in seed.call_args.args[1]],
                             ['mobile-saved-ssh', 'mobile-hidden-RDP', 'mobile-hidden-MySQL', 'mobile-hidden-VNC'])
            self.assertEqual(set(ctx.values), {'mobile_native_receipt', 'mobile_headless_receipt'})

    def test_open_session_case_adds_only_a_credential_free_local_shell(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(case_id='TC-MOBILE-005', case_dir=Path(folder), values={})
            with patch.object(mobile_service, 'seed_sessions') as seed:
                mobile_service.setup(ctx)
            rows = seed.call_args.args[1]
            self.assertEqual(len(rows), 5)
            local = rows[-1]
            self.assertEqual((local['id'], local['name'], local['session_type'], local['auth_method']),
                             (probe.SAVED_ID, probe.SAVED_NAME, 'LocalShell', 'None'))
            self.assertEqual(json.loads(local['options_json']),
                             {'localShellPath': '/bin/bash', 'localShellArgs': probe.SAVED_ARGS})
            self.assertEqual(Path(ctx.values['mobile_open_receipt']).parent, Path(folder))
