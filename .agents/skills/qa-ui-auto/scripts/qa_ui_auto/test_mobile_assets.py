"""Parallel fixture builds must not erase assets already served to a phone."""
import multiprocessing
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

from .fixtures.mobile_assets import build_snapshot, bundle_lock


def hold_bundle(root, entered, release):
    with bundle_lock(root):
        entered.set()
        if not release.wait(10):
            raise RuntimeError('bundle lock owner was not released')


class MobileAssetsTest(unittest.TestCase):
    def test_same_checkout_builds_are_exclusive_across_processes(self):
        with tempfile.TemporaryDirectory() as root:
            context = multiprocessing.get_context('spawn')
            first, second = context.Event(), context.Event()
            release_first, release_second = context.Event(), context.Event()
            processes = [context.Process(target=hold_bundle, args=(root, first, release_first)),
                         context.Process(target=hold_bundle, args=(root, second, release_second))]
            try:
                processes[0].start()
                self.assertTrue(first.wait(5))
                processes[1].start()
                self.assertFalse(second.wait(0.3), 'parallel Vite build can empty active output')
                release_first.set()
                self.assertTrue(second.wait(5))
                release_second.set()
                for process in processes:
                    process.join(5)
                    self.assertEqual(process.exitcode, 0)
            finally:
                release_first.set()
                release_second.set()
                for process in processes:
                    if process.pid:
                        process.join(5)
                        if process.is_alive():
                            process.terminate()
                            process.join(5)

    def test_running_peer_snapshot_survives_next_build_emptying_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / 'src-tauri/resources/mobile-web'
            def build(*_args, **_kwargs):
                (output / 'assets').mkdir(parents=True)
                (output / 'index.html').write_text('<script src="/assets/app.js"></script>')
                (output / 'assets/app.js').write_text('phone bundle')
                return Mock(returncode=0, stdout='built', stderr='')
            with patch('qa_ui_auto.fixtures.mobile_assets.subprocess.run', side_effect=build):
                snapshot = build_snapshot(root, root)
            try:
                shutil.rmtree(output)
                self.assertEqual((Path(snapshot.name) / 'assets/app.js').read_text(), 'phone bundle')
                self.assertTrue((Path(snapshot.name) / 'index.html').is_file())
            finally:
                snapshot.cleanup()

    def test_failed_build_releases_lock_and_does_not_return_partial_assets(self):
        with tempfile.TemporaryDirectory() as root:
            with patch('qa_ui_auto.fixtures.mobile_assets.subprocess.run', return_value=Mock(returncode=1, stdout='', stderr='failed')):
                with self.assertRaisesRegex(RuntimeError, 'Mobile bundle build failed'):
                    build_snapshot(root, root)
            with bundle_lock(root):
                self.assertEqual((Path(root) / 'mobile-build.log').read_text(), 'failed')
