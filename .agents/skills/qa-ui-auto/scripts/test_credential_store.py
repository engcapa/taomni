import json
import os
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto.fixtures import credential_store
from tauri_webdriver import native_isolation_env


class CredentialStoreTest(unittest.TestCase):
    def setUp(self):
        owner = patch.object(credential_store, '_wait_for_service')
        owner.start()
        self.addCleanup(owner.stop)

    def test_local_runs_never_touch_keyring(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(credential_store.subprocess, 'run') as run:
            credential_store.setup(SimpleNamespace(cfg={'app': {'mode': 'native'}}))
            run.assert_not_called()

    def test_hosted_requires_private_bus_and_run_owned_roots(self):
        with patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}, clear=True), \
             patch.object(credential_store.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'private D-Bus'):
                credential_store.setup(SimpleNamespace(cfg={'app': {'mode': 'native'}}))
            run.assert_not_called()

    def test_replace_and_actual_roundtrip_with_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.secrets, 'token_hex', return_value='probe'), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS':'true', 'DBUS_SESSION_BUS_ADDRESS':'private'}
            with patch.dict(os.environ, env, clear=True):
                run.return_value = SimpleNamespace(stdout='probe\n')
                credential_store.setup(ctx)
                self.assertEqual(run.call_args_list[0].args[0],
                                 ['dbus-update-activation-environment', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'])
                self.assertIn('--replace', run.call_args_list[1].args[0])
                self.assertIn('--daemonize', run.call_args_list[1].args[0])
                self.assertEqual([c.args[0][1] for c in run.call_args_list[2:]], ['store','lookup','clear'])
                run.reset_mock();run.return_value = SimpleNamespace(stdout='wrong')
                with self.assertRaisesRegex(RuntimeError, 'roundtrip'):
                    credential_store.setup(ctx)
                self.assertEqual(run.call_args.args[0][1], 'clear')

    def test_cleanup_failure_does_not_mask_failed_store(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            store_error = subprocess.CalledProcessError(1, ['secret-tool', 'store'], stderr='collection locked')
            cleanup_error = subprocess.CalledProcessError(1, ['secret-tool', 'clear'])
            run.side_effect = [SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), store_error, cleanup_error]
            with patch.dict(os.environ, env, clear=True), patch.object(credential_store, 'READINESS_TIMEOUT_SEC', 0):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    credential_store.setup(ctx)
            self.assertIs(caught.exception, store_error)
            self.assertIn('cleanup also failed', caught.exception.__notes__[0])
            self.assertEqual(run.call_args.args[0][1], 'clear')
            trace = json.loads(next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text())
            self.assertEqual(trace['status'], 'failed')
            self.assertEqual(trace['attempts'][0]['failed_operation'], 'store')
            self.assertEqual(trace['failure']['stderr'], 'collection locked')

    def test_failed_cleanup_after_successful_roundtrip_still_fails(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.secrets, 'token_hex', return_value='probe'), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            cleanup_error = subprocess.CalledProcessError(1, ['secret-tool', 'clear'])
            run.side_effect = [SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), SimpleNamespace(stdout='probe\n'), cleanup_error]
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    credential_store.setup(ctx)
            self.assertIs(caught.exception, cleanup_error)

    def test_initial_unready_service_requires_a_later_real_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.secrets, 'token_hex', return_value='probe-secret'), \
             patch.object(credential_store.time, 'sleep'), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            unavailable = subprocess.CalledProcessError(1, ['secret-tool', 'store'], stderr='service unavailable')
            run.side_effect = [SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), unavailable,
                               SimpleNamespace(stdout=''), SimpleNamespace(stdout=''),
                               SimpleNamespace(stdout='probe-secret\n'), SimpleNamespace(stdout='')]
            with patch.dict(os.environ, env, clear=True):
                credential_store.setup(ctx)
            self.assertEqual([call.args[0][1] for call in run.call_args_list[2:]],
                             ['store', 'clear', 'store', 'lookup', 'clear'])
            report = next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text()
            self.assertNotIn('probe-secret', report)
            trace = json.loads(report)
            self.assertEqual(trace['status'], 'ready')
            self.assertEqual([attempt['status'] for attempt in trace['attempts']], ['failed', 'ready'])
            self.assertEqual(trace['attempts'][0]['failure']['stderr'], 'service unavailable')

    def test_permanently_unavailable_service_fails_at_deadline(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.time, 'sleep'), \
             patch.object(credential_store.time, 'monotonic') as monotonic, \
             patch.object(credential_store, 'READINESS_TIMEOUT_SEC', 1), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            now = [0.0]
            monotonic.side_effect = lambda: now[0]
            unavailable = subprocess.CalledProcessError(1, ['secret-tool', 'store'], stderr='collection locked')

            def execute(command, **kwargs):
                if command[0] == 'secret-tool' and command[1] == 'store':
                    now[0] += 0.75
                    raise unavailable
                return SimpleNamespace(stdout='')

            run.side_effect = execute
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    credential_store.setup(ctx)
            self.assertIs(caught.exception, unavailable)
            trace = json.loads(next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text())
            self.assertEqual(trace['status'], 'failed')
            self.assertEqual(len(trace['attempts']), 2)

    def test_activation_environment_failure_cannot_start_a_daemon_with_stale_roots(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.subprocess, 'run') as run:
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            failure = subprocess.CalledProcessError(1, ['dbus-update-activation-environment'], stderr='private bus rejected update')
            run.side_effect = failure
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    credential_store.setup(ctx)
            self.assertIs(caught.exception, failure)
            self.assertEqual(run.call_count, 1)
            trace = json.loads(next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text())
            self.assertEqual(trace['failure']['stderr'], 'private bus rejected update')

    def test_diagnostic_write_failure_preserves_the_service_error(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.subprocess, 'run') as run, \
             patch.object(Path, 'write_text', side_effect=OSError('disk full')):
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            env = {**native_isolation_env(ctx.report_root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            failure = subprocess.CalledProcessError(1, ['dbus-update-activation-environment'], stderr='bus unavailable')
            run.side_effect = failure
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    credential_store.setup(ctx)
            self.assertIs(caught.exception, failure)
            self.assertIn('diagnostics also failed', caught.exception.__notes__[0])


class MissingCollectionRecoveryTest(unittest.TestCase):
    def setUp(self):
        owner = patch.object(credential_store, '_wait_for_service')
        owner.start()
        self.addCleanup(owner.stop)

    @contextmanager
    def fixture(self, execute):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(credential_store.platform, 'system', return_value='Linux'), \
             patch.object(credential_store.secrets, 'token_hex', return_value='probe-secret'), \
             patch.object(credential_store.time, 'sleep'), \
             patch.object(credential_store.subprocess, 'run', side_effect=execute) as run:
            root = Path(directory)
            ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=root)
            env = {**native_isolation_env(root), 'GITHUB_ACTIONS': 'true', 'DBUS_SESSION_BUS_ADDRESS': 'private'}
            with patch.dict(os.environ, env, clear=True):
                yield ctx, run

    def missing(self):
        return subprocess.CalledProcessError(
            1, ['secret-tool', 'store'],
            stderr='secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”',
        )

    def test_missing_collection_restarts_once_and_requires_a_new_complete_roundtrip(self):
        state = {'daemons': 0, 'now': 0.0}
        def execute(command, **kwargs):
            if command[0] == 'gnome-keyring-daemon':
                state['daemons'] += 1
            if command[:2] == ['secret-tool', 'store'] and state['daemons'] < 2:
                state['now'] += 0.5
                raise self.missing()
            return SimpleNamespace(stdout='probe-secret\n' if command[:2] == ['secret-tool', 'lookup'] else '')
        with self.fixture(execute) as (ctx, run), \
             patch.object(credential_store.time, 'monotonic', side_effect=lambda: state['now']):
            credential_store.setup(ctx)
            self.assertEqual([c.args[0][:2] for c in run.call_args_list[2:]], [
                ['secret-tool', 'store'], ['secret-tool', 'clear'],
                ['gnome-keyring-daemon', '--replace'],
                ['secret-tool', 'store'], ['secret-tool', 'lookup'], ['secret-tool', 'clear'],
            ])
            text = next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text()
            trace = json.loads(text)
            self.assertNotIn('probe-secret', text)
            self.assertEqual(trace['status'], 'ready')
            self.assertEqual(trace['attempts'][0]['failure']['stderr'], self.missing().stderr)
            self.assertEqual(trace['collection_recovery']['status'], 'restarted')

    def test_persistent_missing_collection_still_fails_without_repeated_restarts(self):
        now = [0.0]
        def execute(command, **kwargs):
            if command[:2] == ['secret-tool', 'store']:
                now[0] += 0.75
                raise self.missing()
            return SimpleNamespace(stdout='')
        with self.fixture(execute) as (ctx, run), \
             patch.object(credential_store.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(credential_store, 'READINESS_TIMEOUT_SEC', 1):
            with self.assertRaises(subprocess.CalledProcessError):
                credential_store.setup(ctx)
            restarts = [c for c in run.call_args_list if c.args[0][0] == 'gnome-keyring-daemon']
            self.assertEqual(len(restarts), 2)  # Initial setup and one recovery.
            self.assertEqual(restarts[-1].kwargs['timeout'], 0.25)
            self.assertEqual(now[0], 1.5)
            trace = json.loads(next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text())
            self.assertEqual(trace['status'], 'failed')

    def test_recovery_daemon_failure_is_terminal_and_preserves_initial_error(self):
        failure = subprocess.TimeoutExpired(['gnome-keyring-daemon'], 0.5)
        replies = iter([SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), self.missing(),
                        SimpleNamespace(stdout=''), failure])
        def execute(*args, **kwargs):
            reply = next(replies)
            if isinstance(reply, Exception):
                raise reply
            return reply
        with self.fixture(execute) as (ctx, run):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                credential_store.setup(ctx)
            self.assertIs(caught.exception, failure)
            self.assertEqual(run.call_count, 5)
            trace = json.loads(next(ctx.report_root.glob('credential-store-readiness/*.json')).read_text())
            self.assertIn('collection/login', trace['attempts'][0]['failure']['stderr'])
            self.assertEqual(trace['status'], 'failed')

    def test_unrelated_store_error_cannot_trigger_a_collection_restart(self):
        failure = subprocess.CalledProcessError(1, ['secret-tool', 'store'], stderr='collection locked')
        replies = iter([SimpleNamespace(stdout=''), SimpleNamespace(stdout=''), failure,
                        SimpleNamespace(stdout=''), SimpleNamespace(stdout=''),
                        SimpleNamespace(stdout='probe-secret\n'), SimpleNamespace(stdout='')])
        def execute(*args, **kwargs):
            reply = next(replies)
            if isinstance(reply, Exception):
                raise reply
            return reply
        with self.fixture(execute) as (ctx, run):
            credential_store.setup(ctx)
            self.assertEqual(sum(c.args[0][0] == 'gnome-keyring-daemon' for c in run.call_args_list), 1)
