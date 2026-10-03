import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

from qa_ui_auto import updater_fixture
from qa_ui_auto.testcase import load_case
from qa_ui_auto.behavior_contract import validate_contract


class UpdaterFixtureUnitTests(unittest.TestCase):
    def test_cached_asset_is_reused_only_with_exact_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.joinpath('asset').write_bytes(b'signed bytes')
            expected = hashlib.sha256(b'signed bytes').hexdigest()
            with patch.object(updater_fixture, 'urlopen') as network:
                result = updater_fixture.download_asset(root, 'asset', expected)
                self.assertEqual(result.read_bytes(), b'signed bytes')
                network.assert_not_called()

    def test_corrupt_download_is_never_retained_as_valid(self):
        import io
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(updater_fixture, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(b'wrong')) as network, patch.object(updater_fixture.time, 'sleep'):
                with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                    updater_fixture.download_asset(root, 'asset', '0' * 64)
                self.assertEqual(network.call_count, 3)
                self.assertFalse(root.joinpath('asset').exists())

    def test_mode_change_only_rewrites_run_owned_fixture_config(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            fixture = SimpleNamespace(profile=profile, server=SimpleNamespace(server_port=12345), install_root=profile / 'Disposable.app')
            updater_fixture.UpdaterFixture.set_mode(fixture, 'correct')
            config = json.loads(profile.joinpath('updater-qa.json').read_text())
            self.assertEqual(config['endpoint'], 'http://127.0.0.1:12345/correct/latest.json')
            self.assertEqual(config['installRoot'], str(fixture.install_root))
            with self.assertRaises(ValueError):
                updater_fixture.UpdaterFixture.set_mode(fixture, 'external')

    def test_updater_cases_have_reviewed_executable_contracts(self):
        for path in Path('qa-ui-auto-tests/cases').glob('TC-UPDATE-MACOS-*.testcase.yaml'):
            case = load_case(path)
            self.assertEqual(case.modes, ['native'])
            self.assertEqual(case.native_platforms, ['macOS'])
            doc = yaml.safe_load(path.read_text())
            self.assertEqual(validate_contract(doc, require_review=True), [])


if __name__ == '__main__':
    unittest.main()
