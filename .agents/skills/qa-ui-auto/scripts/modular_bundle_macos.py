"""Inspect a real DMG and updater app on its matching macOS architecture.

No application, keychain, Gatekeeper policy or TCC state is changed. The copied
app receives quarantine for observation; rejection remains an explicit result.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import subprocess
import tarfile
import tempfile

from modular_bundle_inventory import digest, module_reexec_arguments, tree_sample, write_json


def run(command: list[str], output: Path, *, required: bool = True) -> dict:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=120)
    output.write_text(result.stdout, encoding='utf-8')
    receipt = {'command': command, 'exitCode': result.returncode, 'log': output.name}
    if required and result.returncode:
        raise RuntimeError(f'{command[0]} failed with {result.returncode}; see {output}')
    return receipt


def app_identity(app: Path, version: str) -> dict:
    with (app / 'Contents/Info.plist').open('rb') as stream:
        fields = plistlib.load(stream)
    if (fields.get('CFBundleIdentifier') != 'com.taomni.app'
            or fields.get('CFBundleShortVersionString') != version
            or fields.get('CFBundleExecutable') != 'taomni'):
        raise ValueError('DMG/updater app identity differs')
    binary = app / 'Contents/MacOS/taomni'
    if not binary.is_file():
        raise ValueError('packaged application executable is missing')
    return {'identifier': fields['CFBundleIdentifier'], 'version': version,
            'executableSha256': digest(binary)}


def extract_updater(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive, 'r:gz') as source:
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            parts = tuple(part for part in path.parts if part != '.')
            if (not parts or parts[0] != 'Taomni.app' or path.is_absolute()
                    or '..' in parts or '\\' in member.name):
                raise ValueError('updater archive escapes its application root')
        # The data filter also checks link targets and rejects device files.
        source.extractall(destination, filter='data')
    return destination / 'Taomni.app'


def inspect(directory: Path, identity: dict, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='taomni-package-probe-'))
    mount = work / 'mounted'
    mount.mkdir()
    attached = False
    evidence = {'scope': 'package-payload-and-system-assessment', 'completed': False,
                'source': identity, 'observations': [], 'applicationLaunched': False,
                'installedUpgradeEstablished': False, 'systemTrustEstablished': False}
    write_json(output / 'macos-payload.json', evidence)
    try:
        dmg = next(directory.glob('*.dmg')).resolve()
        result = subprocess.run(
            ['hdiutil', 'attach', '-readonly', '-nobrowse', '-plist',
             '-mountpoint', str(mount), str(dmg)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        (output / 'dmg-attach.plist').write_bytes(result.stdout)
        (output / 'dmg-attach.stderr.log').write_bytes(result.stderr)
        # An attach command can fail after mounting; inspect only our mountpoint.
        attached = mount.is_mount()
        if result.returncode:
            raise RuntimeError('cannot attach the real DMG; see dmg-attach.stderr.log')
        attached = True
        applications = list(mount.glob('*.app'))
        if len(applications) != 1 or applications[0].name != 'Taomni.app':
            raise ValueError('expected exactly one Taomni.app in DMG')
        app = work / 'copied/Taomni.app'
        run(['ditto', str(applications[0]), str(app)], output / 'dmg-copy.log')
        evidence['app'] = app_identity(app, identity['version'])
        evidence['moduleReexecArguments'] = module_reexec_arguments(app / 'Contents/MacOS/taomni')
        evidence['payload'] = tree_sample(app)
        architectures = subprocess.check_output(
            ['lipo', '-archs', str(app / 'Contents/MacOS/taomni')], text=True).strip()
        expected = 'arm64' if identity['target'] == 'darwin-aarch64' else 'x86_64'
        if architectures != expected:
            raise ValueError(f'app architecture differs: {architectures}, expected {expected}')
        evidence['architectures'] = architectures
        evidence['observations'].append(run(
            ['codesign', '--verify', '--deep', '--strict', '--verbose=4', str(app)],
            output / 'dmg-codesign-verify.log'))
        evidence['observations'].append(run(
            ['codesign', '-d', '--verbose=4', '-r-', str(app)],
            output / 'dmg-codesign-details.log'))
        runtime_check = Path(__file__).resolve().parents[4] / 'scripts/verify-macos-runtime-paths.sh'
        evidence['observations'].append(run(
            ['bash', str(runtime_check), str(app)], output / 'dmg-runtime-paths.log'))
        archives = list(directory.glob('*.app.tar.gz'))
        evidence['updaterArchivePresent'] = bool(archives)
        if archives:
            updater = extract_updater(archives[0], work / 'updater')
            evidence['updater'] = app_identity(updater, identity['version'])
            if evidence['updater'] != evidence['app']:
                raise ValueError('updater and DMG application identities/bytes differ')
            evidence['observations'].append(run(
                ['codesign', '--verify', '--deep', '--strict', '--verbose=4', str(updater)],
                output / 'updater-codesign-verify.log'))
        else:
            evidence['updaterGap'] = 'No updater app archive was uploaded; updater validation is unverified.'
        # Do not delete or bypass quarantine on either producer input. Only this
        # disposable copy is marked, preserving the actual signed app bytes.
        run(['xattr', '-w', 'com.apple.quarantine', '0081;00000000;TaomniPackageProbe;', str(app)],
            output / 'quarantine-write.log')
        evidence['observations'].append(run(
            ['xattr', '-p', 'com.apple.quarantine', str(app)], output / 'quarantine-read.log'))
        assessment = run(['spctl', '--assess', '--type', 'execute', '--verbose=4', str(app)],
                         output / 'gatekeeper-assessment.log', required=False)
        evidence['observations'].append(assessment)
        evidence['gatekeeperAccepted'] = assessment['exitCode'] == 0
        # Acceptance on one hosted OS is an observation, never blanket G1/TCC.
        if digest(app / 'Contents/MacOS/taomni') != evidence['app']['executableSha256']:
            raise ValueError('assessment changed application bytes')
        evidence['completed'] = True
    finally:
        write_json(output / 'macos-payload.json', evidence)
        if attached:
            result = subprocess.run(['hdiutil', 'detach', str(mount)],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, timeout=120)
            (output / 'dmg-detach.log').write_text(result.stdout, encoding='utf-8')
            if result.returncode:
                # Never recurse through a mount whose detach was not confirmed.
                raise RuntimeError(f'DMG detach failed; retained {work}')
        shutil.rmtree(work)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('directory', 'identity', 'out'):
        parser.add_argument(f'--{key}', type=Path, required=True)
    args = parser.parse_args()
    inspect(args.directory, json.loads(args.identity.read_text(encoding='utf-8')), args.out)


if __name__ == '__main__':
    main()
