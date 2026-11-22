from __future__ import annotations

from copy import deepcopy
import io
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest

from modular_bundle_inventory import inventory, plan_targets, tree_sample, validate_payload, validate_source
from modular_bundle_macos import app_identity, extract_updater


SOURCE = 'a' * 40


def source_fixture():
    run = {'id': 123, 'head_sha': SOURCE, 'path': '.github/workflows/release.yml',
           'event': 'workflow_dispatch', 'repository': {'full_name': 'engcapa/taomni'},
           'head_repository': {'full_name': 'engcapa/taomni'},
           'status': 'in_progress', 'conclusion': None}
    artifact = {'id': 456, 'name': 'taomni-0.6.0-ubuntu-22.04', 'expired': False,
                'size_in_bytes': 1024, 'digest': 'sha256:' + 'b' * 64,
                'workflow_run': {'id': 123, 'head_sha': SOURCE}}
    return run, {'total_count': 1, 'artifacts': [artifact]}


def validate(run, artifacts):
    return validate_source(run, artifacts, repository='engcapa/taomni', run_id='123',
                           source=SOURCE, version='0.6.0', target='linux-x86_64')


class BundleSourceTests(unittest.TestCase):
    def test_only_explicit_supported_targets_are_scheduled(self):
        self.assertEqual(plan_targets('linux-x86_64'),
                         {'include': [{'os': 'ubuntu-22.04', 'target': 'linux-x86_64'}]})
        self.assertEqual(len(plan_targets('all')['include']), 4)
        self.assertEqual([row['target'] for row in plan_targets('darwin-x86_64, windows-x86_64')['include']],
                         ['darwin-x86_64', 'windows-x86_64'])
        for value in ['', 'all,linux-x86_64', 'linux-x86_64,linux-x86_64', 'self-hosted', 'windows-arm64']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan_targets(value)

    def test_macos_26_upgrade_keeps_the_producer_target_and_intel_runner(self):
        matrix = plan_targets('darwin-aarch64,darwin-x86_64', upgrade_desktop=True, macos_arm_runner='macos-26')
        self.assertEqual(matrix['include'], [
            {'os': 'macos-26', 'target': 'darwin-aarch64'},
            {'os': 'macos-15-intel', 'target': 'darwin-x86_64'},
        ])
        with self.assertRaisesRegex(ValueError, 'supported macOS ARM64 runner'):
            plan_targets('darwin-aarch64', macos_arm_runner='self-hosted')

    def test_completed_artifact_can_be_sampled_before_the_other_builders_finish(self):
        run, artifacts = source_fixture()
        result = validate(run, artifacts)
        self.assertEqual(result['producerSource'], SOURCE)
        self.assertEqual(result['producerStatusObserved'], 'in_progress')
        self.assertIsNone(result['producerConclusionObserved'])
        self.assertEqual(result['artifact']['id'], 456)

    def test_release_bundle_after_the_first_hundred_artifacts_can_be_selected(self):
        run, artifacts = source_fixture()
        first = [{'id': number, 'name': f'module-{number}'} for number in range(1, 101)]
        pages = [{'total_count': 101, 'artifacts': first},
                 {'total_count': 101, 'artifacts': artifacts['artifacts']}]
        self.assertEqual(validate(run, pages)['artifact']['id'], 456)
        for incomplete in [pages[:1], [*pages, pages[1]], [pages[0], {**pages[1], 'total_count': 102}]]:
            with self.subTest(incomplete=len(incomplete)), self.assertRaisesRegex(ValueError, 'incomplete'):
                validate(run, incomplete)

    def test_wrong_run_source_repository_workflow_and_fork_are_rejected(self):
        run, artifacts = source_fixture()
        for field, value in [('id', 999), ('head_sha', 'c' * 40), ('path', 'qa.yml'),
                             ('event', 'pull_request'), ('repository', {'full_name': 'other/repo'}),
                             ('head_repository', {'full_name': 'fork/taomni'})]:
            with self.subTest(field=field):
                candidate = deepcopy(run)
                candidate[field] = value
                with self.assertRaises(ValueError):
                    validate(candidate, artifacts)

    def test_empty_expired_replaced_duplicated_and_incomplete_artifacts_are_rejected(self):
        run, artifacts = source_fixture()
        for update in [{'expired': True}, {'size_in_bytes': 0}, {'id': -1},
                       {'workflow_run': {'id': 999, 'head_sha': SOURCE}},
                       {'workflow_run': {'id': 123, 'head_sha': 'c' * 40}},
                       {'digest': 'sha256:invalid'}, {'name': 'taomni-0.5.9-ubuntu-22.04'}]:
            with self.subTest(update=update):
                candidate = deepcopy(artifacts)
                candidate['artifacts'][0].update(update)
                with self.assertRaises(ValueError):
                    validate(run, candidate)
        for candidate in [{'total_count': 2, 'artifacts': artifacts['artifacts']},
                          {'total_count': 2, 'artifacts': artifacts['artifacts'] * 2}]:
            with self.assertRaises(ValueError):
                validate(run, candidate)


class BundleFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.identity = validate(*source_fixture())
        self.names = ['Taomni_0.6.0_amd64.deb', 'Taomni-0.6.0-1.x86_64.rpm',
                      'Taomni_0.6.0_amd64.AppImage']
        for index, name in enumerate(self.names):
            (self.root / name).write_bytes(bytes([index]) * (index + 1))

    def test_raw_sizes_hashes_and_scope_are_preserved(self):
        result = inventory(self.root, self.identity)
        self.assertEqual(result['totalArtifactFileBytes'], 6)
        self.assertEqual(len(result['files']), 3)
        self.assertEqual({row['bytes'] for row in result['files']}, {1, 2, 3})
        self.assertTrue(all(len(row['sha256']) == 64 for row in result['files']))
        self.assertIn('installed-upgrade', result['notEstablished'])
        old = result['files']
        (self.root / self.names[0]).write_bytes(b'changed')
        self.assertNotEqual(old, inventory(self.root, self.identity)['files'])

    def test_missing_empty_wrong_version_and_duplicate_packages_fail(self):
        path = self.root / self.names[0]
        for name, data in [('Taomni_0.5.9_amd64.deb', b'old'), (self.names[0], b'')]:
            path.unlink()
            path = self.root / name
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                inventory(self.root, self.identity)
        path.unlink()
        with self.assertRaises(ValueError):
            inventory(self.root, self.identity)
        path.write_bytes(b'new')
        (self.root / 'Taomni_0.6.0_other.deb').write_bytes(b'duplicate')
        with self.assertRaises(ValueError):
            inventory(self.root, self.identity)

    def test_tree_samples_count_links_separately(self):
        result = tree_sample(self.root)
        self.assertEqual(result['regularFiles'], 3)
        self.assertEqual(result['regularFileBytes'], 6)
        self.assertEqual(result['largestFiles'][0]['bytes'], 3)

    def test_macos_and_windows_use_their_actual_package_families(self):
        targets = {
            'windows-x86_64': ['Taomni_0.6.0_x64_en-US.msi', 'Taomni_0.6.0_x64-setup.exe'],
            'darwin-aarch64': ['Taomni_0.6.0_aarch64.dmg'],
            'darwin-x86_64': ['Taomni_0.6.0_x64.dmg', 'Taomni.app.tar.gz'],
        }
        for target, names in targets.items():
            with self.subTest(target=target):
                directory = self.root / target
                directory.mkdir()
                for name in names:
                    (directory / name).write_bytes(b'package')
                result = inventory(directory, {**self.identity, 'target': target})
                self.assertEqual(len(result['files']), len(names))
                self.assertEqual(result['totalArtifactFileBytes'], 7 * len(names))
                if target.startswith('darwin'):
                    duplicate = directory / 'other.app.tar.gz'
                    duplicate.write_bytes(b'archive')
                    if 'Taomni.app.tar.gz' not in names:
                        (directory / 'Taomni.app.tar.gz').write_bytes(b'archive')
                    with self.assertRaises(ValueError):
                        inventory(directory, {**self.identity, 'target': target})

    def test_payload_samples_require_real_byte_totals_on_every_target(self):
        sample = {'regularFiles': 2, 'regularFileBytes': 10,
                  'largestFiles': [{'path': 'app', 'bytes': 6}, {'path': 'runtime', 'bytes': 4}]}
        for target in ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']:
            def wrap(value):
                return value if target.startswith('windows') else {'completed': True, 'payload': value}
            validate_payload(target, wrap(sample))
            for patch in [{'regularFileBytes': None}, {'regularFileBytes': 9},
                          {'regularFileBytes': 11}, {'regularFileBytes': 0},
                          {'regularFiles': True}, {'largestFiles': []}]:
                with self.subTest(target=target, patch=patch), self.assertRaises(ValueError):
                    validate_payload(target, wrap({**sample, **patch}))
        with self.assertRaises(ValueError):
            validate_payload('darwin-aarch64', {'completed': False, 'payload': sample})

    def test_updater_must_stay_within_the_real_app_root(self):
        for member in ['../escaped', '/absolute', 'Other.app/Contents/MacOS/app']:
            with self.subTest(member=member):
                archive = self.root / 'bad.tar.gz'
                with tarfile.open(archive, 'w:gz') as output:
                    item = tarfile.TarInfo(member)
                    item.size = 1
                    output.addfile(item, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    extract_updater(archive, self.root / 'unpacked')
        self.assertFalse((self.root.parent / 'escaped').exists())

    def test_updater_contents_extract_but_links_cannot_escape(self):
        archive = self.root / 'app.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            item = tarfile.TarInfo('./Taomni.app/Contents/MacOS/taomni')
            item.size = 6
            output.addfile(item, io.BytesIO(b'binary'))
        app = extract_updater(archive, self.root / 'valid')
        self.assertEqual((app / 'Contents/MacOS/taomni').read_bytes(), b'binary')
        with tarfile.open(archive, 'w:gz') as output:
            item = tarfile.TarInfo('Taomni.app/Contents/escape')
            item.type = tarfile.SYMTYPE
            item.linkname = '../../../outside'
            output.addfile(item)
        with self.assertRaises(tarfile.FilterError):
            extract_updater(archive, self.root / 'invalid')

    def test_inner_app_identifier_version_and_executable_are_required(self):
        app = self.root / 'Taomni.app'
        binary = app / 'Contents/MacOS/taomni'
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b'packaged executable')
        fields = {'CFBundleIdentifier': 'com.taomni.app',
                  'CFBundleShortVersionString': '0.6.0', 'CFBundleExecutable': 'taomni'}
        info = app / 'Contents/Info.plist'
        info.write_bytes(plistlib.dumps(fields))
        valid = app_identity(app, '0.6.0')
        self.assertEqual(valid['version'], '0.6.0')
        for key, value in [('CFBundleIdentifier', 'com.taomni.app.qa'),
                           ('CFBundleShortVersionString', '0.5.9'),
                           ('CFBundleExecutable', 'other')]:
            info.write_bytes(plistlib.dumps({**fields, key: value}))
            with self.assertRaises(ValueError):
                app_identity(app, '0.6.0')
        info.write_bytes(plistlib.dumps(fields))
        binary.unlink()
        with self.assertRaises(ValueError):
            app_identity(app, '0.6.0')


if __name__ == '__main__':
    unittest.main()
