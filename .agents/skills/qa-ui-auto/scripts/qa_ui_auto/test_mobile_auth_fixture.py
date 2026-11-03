"""Proxy fixture paths must match native QA configuration on every OS."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from .fixtures.mobile_connection_auth import app_proxy_fixture_path


class MobileAuthFixtureTest(unittest.TestCase):
    def test_application_proxy_path_matches_each_native_config_resolver(self):
        for system in ['Linux', 'Windows', 'Darwin']:
            with self.subTest(system=system), TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                context = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=root)
                with patch('tauri_webdriver.platform.system', return_value=system):
                    environment = native_isolation_env(root)
                    with patch.dict(os.environ, environment, clear=True):
                        actual = app_proxy_fixture_path(context)
                expected = root / 'native-appconfig'
                if system != 'Linux':
                    expected /= QA_APP_ID
                self.assertEqual(actual, expected / 'taomni' / 'proxy.json')
                self.assertTrue(actual.is_relative_to(root))

    def test_refuses_unverified_native_roots(self):
        with TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            context = SimpleNamespace(cfg={'app': {'mode': 'native'}}, report_root=Path(directory))
            with self.assertRaisesRegex(RuntimeError, 'isolation environment'):
                app_proxy_fixture_path(context)


if __name__ == '__main__':
    unittest.main()
