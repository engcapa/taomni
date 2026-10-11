import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from qa_ui_auto.fixtures import credential_store
from tauri_webdriver import native_isolation_env


class CredentialStoreTest(unittest.TestCase):
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
                self.assertIn('--replace', run.call_args_list[0].args[0])
                self.assertEqual([c.args[0][1] for c in run.call_args_list[1:]], ['store','lookup','clear'])
                run.reset_mock();run.return_value = SimpleNamespace(stdout='wrong')
                with self.assertRaisesRegex(RuntimeError, 'roundtrip'):
                    credential_store.setup(ctx)
                self.assertEqual(run.call_args.args[0][1], 'clear')
