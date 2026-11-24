"""Bind real release-bundle samples to their producer, independently of QA builds.

This records package bytes and payload metadata. It neither launches the app nor
establishes installed-profile migration, application startup or system trust.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from mmap import ACCESS_READ, mmap
from pathlib import Path
import re
import subprocess
import tempfile


TARGETS = {
    'linux-x86_64': ('ubuntu-22.04', ('.deb', '.rpm', '.AppImage')),
    'windows-x86_64': ('windows-latest', ('.msi', '-setup.exe')),
    'darwin-aarch64': ('macos-aarch64', ('.dmg',)),
    'darwin-x86_64': ('macos-x86_64', ('.dmg',)),
}

RUNNERS = {'linux-x86_64': 'ubuntu-22.04', 'windows-x86_64': 'windows-latest',
           'darwin-aarch64': 'macos-15', 'darwin-x86_64': 'macos-15-intel'}

MODULE_REEXEC_ARGUMENTS = ('--vnc-special-key-hook', '--sockscap-redirector-bridge')
SOCKSCAP_EXECUTABLES = {'xray', 'xray.exe', 'sockscap-redirector-bridge', 'taomni-sockscap-trace-launcher',
                       'sockscap-helper.exe', 'windivert.dll', 'windivert64.sys'}


def plan_targets(value: str, *, upgrade_desktop: bool = False, include_linux_inventory: bool = False,
                 macos_arm_runner: str = 'macos-15') -> dict:
    if macos_arm_runner not in {'macos-15', 'macos-26'}:
        raise ValueError('select a supported macOS ARM64 runner')
    supported = [target for target in TARGETS
                 if not upgrade_desktop or include_linux_inventory or not target.startswith('linux-')]
    targets = supported if value == 'all' else [part.strip() for part in value.split(',')]
    if not targets or len(set(targets)) != len(targets) or any(target not in supported for target in targets):
        raise ValueError('select all or unique supported package targets')
    runners = {**RUNNERS, 'darwin-aarch64': macos_arm_runner}
    return {'include': [{'os': runners[target], 'target': target} for target in targets]}


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def artifact_rows(listing: dict | list) -> list[dict]:
    # gh api --paginate --slurp retains the total reported on each page.
    pages = listing if isinstance(listing, list) else [listing]
    rows = [row for page in pages for row in page['artifacts']]
    if (not pages or any(page.get('total_count') != len(rows) for page in pages)
            or len({row['id'] for row in rows}) != len(rows)):
        raise ValueError('artifact listing is incomplete or changed during pagination')
    return rows


def validate_source(run: dict, artifacts: dict | list, *, repository: str, run_id: str,
                    source: str, version: str, target: str) -> dict:
    if not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('bundle run must be a positive integer')
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('bundle source must be a full commit SHA')
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('invalid bundle version')
    if target not in TARGETS:
        raise ValueError('unknown bundle target')
    if (str(run.get('id')) != run_id or run.get('head_sha') != source
            or run.get('path') != '.github/workflows/release.yml'
            or run.get('event') != 'workflow_dispatch'
            or run.get('repository', {}).get('full_name') != repository
            or run.get('head_repository', {}).get('full_name') != repository):
        raise ValueError('release producer identity differs from the requested sample')
    rows = artifact_rows(artifacts)
    name = f'taomni-{version}-{TARGETS[target][0]}'
    selected = [row for row in rows if row.get('name') == name]
    if len(selected) != 1:
        raise ValueError(f'expected exactly one uploaded package artifact: {name}')
    artifact = selected[0]
    origin = artifact.get('workflow_run', {})
    if (artifact.get('expired') is not False or artifact.get('size_in_bytes', 0) <= 0
            or not isinstance(artifact.get('id'), int) or artifact['id'] <= 0
            or str(origin.get('id')) != run_id or origin.get('head_sha') != source):
        raise ValueError('artifact is expired, empty or has a different producer')
    checksum = artifact.get('digest')
    if checksum is not None and not re.fullmatch(r'sha256:[0-9a-f]{64}', checksum):
        raise ValueError('invalid GitHub artifact digest')
    return {
        'schema': 1, 'kind': 'release-bundle-sample', 'repository': repository,
        'producerRun': int(run_id), 'producerSource': source, 'target': target,
        'version': version, 'producerStatusObserved': run.get('status'),
        'producerConclusionObserved': run.get('conclusion'),
        'artifact': {key: artifact.get(key) for key in
                     ('id', 'name', 'size_in_bytes', 'digest', 'created_at')},
    }


def inventory(directory: Path, identity: dict) -> dict:
    rows = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise ValueError('package artifact contains a link or special file')
        if path.is_file():
            if path.parent != directory:
                raise ValueError('expected flat release-bundle artifacts')
            if path.stat().st_size == 0:
                raise ValueError('empty release artifact')
            rows.append({'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
    required = TARGETS[identity['target']][1]
    for suffix in required:
        matches = [row for row in rows if row['name'].endswith(suffix)]
        if len(matches) != 1:
            raise ValueError(f'expected one actual package ending with {suffix}')
        # Tauri's updater app archive has no version in its canonical filename.
        # Its inner Info.plist is checked by the macOS payload probe instead.
        if suffix != '.app.tar.gz' and f"_{identity['version']}_" not in matches[0]['name']:
            if not (suffix == '.rpm' and f"-{identity['version']}-" in matches[0]['name']):
                raise ValueError('package filename has a different version')
    if sum(row['name'].endswith('.app.tar.gz') for row in rows) > 1:
        raise ValueError('ambiguous updater app archive')
    return {
        **identity, 'files': rows, 'totalArtifactFileBytes': sum(row['bytes'] for row in rows),
        'scope': ['package-size', 'package-sha256', 'producer-identity'],
        'notEstablished': ['installed-upgrade', 'legacy-exporter', 'startup-latency',
                           'resident-memory', 'system-distribution-trust', 'G1-G11'],
    }


def tree_sample(root: Path) -> dict:
    """Record the extracted files and their digests without following links."""
    rows = []
    links = []
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            links.append({'path': name, 'target': str(path.readlink())})
        elif path.is_file():
            rows.append({'path': name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
    return {'regularFiles': len(rows), 'regularFileBytes': sum(row['bytes'] for row in rows),
            'files': rows,
            'largestFiles': sorted(rows, key=lambda row: (-row['bytes'], row['path']))[:25],
            'symlinks': links}


def module_reexec_arguments(executable: Path) -> dict[str, bool]:
    with executable.open('rb') as stream, mmap(stream.fileno(), 0, access=ACCESS_READ) as contents:
        return {argument: contents.find(argument.encode('ascii')) >= 0
                for argument in MODULE_REEXEC_ARGUMENTS}


def validate_payload(target: str, evidence: dict) -> None:
    if target not in TARGETS:
        raise ValueError('unknown bundle target')
    if target.startswith('darwin') and evidence.get('completed') is not True:
        raise ValueError('macOS package inspection did not complete')
    sample = evidence if target == 'windows-x86_64' else evidence.get('payload', {})
    count, size = sample.get('regularFiles'), sample.get('regularFileBytes')
    if type(count) is not int or count <= 0 or type(size) is not int or size <= 0:
        raise ValueError('payload file count and byte total must be positive integers')
    rows = sample.get('largestFiles', [])
    if not rows or len(rows) != min(25, count):
        raise ValueError('payload largest-file samples are missing or incomplete')
    if any(type(row.get('bytes')) is not int or row['bytes'] < 0 for row in rows):
        raise ValueError('payload file sizes must be nonnegative integers')
    selected_bytes = sum(row['bytes'] for row in rows)
    if selected_bytes > size or (count <= 25 and selected_bytes != size):
        raise ValueError('payload byte total differs from its file samples')


def record_payload_receipt(target: str, directory: Path) -> None:
    name = ('macos' if target.startswith('darwin') else target.split('-')[0]) + '-payload.json'
    raw = directory / name
    evidence = json.loads(raw.read_text(encoding='utf-8-sig'))
    validate_payload(target, evidence)
    sample = evidence if target == 'windows-x86_64' else evidence['payload']
    files = sample.get('files', [])
    if len(files) != sample['regularFiles'] or len({row['path'] for row in files}) != len(files):
        raise ValueError('core payload inventory is incomplete or contains duplicate paths')
    if any(type(row['bytes']) is not int or row['bytes'] < 0 or
           not re.fullmatch('[0-9a-f]{64}', row.get('sha256', '')) for row in files):
        raise ValueError('core payload inventory has an invalid size or digest')
    if sum(row['bytes'] for row in files) != sample['regularFileBytes']:
        raise ValueError('core payload file bytes do not match the observed total')
    if sorted(files, key=lambda row: (-row['bytes'], row['path']))[:25] != sample['largestFiles']:
        raise ValueError('core payload file inventory differs from its largest-file sample')
    for row in files:
        if row['path'].replace('\\', '/').rsplit('/', 1)[-1].casefold() in SOCKSCAP_EXECUTABLES:
            raise ValueError(f"core payload contains a module-owned SocksCap file: {row['path']}")

    if target.startswith('darwin-'):
        executable_path = 'Contents/MacOS/taomni'
        executable_hash = evidence.get('app', {}).get('executableSha256')
    else:
        executable_path = 'taomni.exe' if target == 'windows-x86_64' else 'usr/bin/taomni'
        executable_hash = evidence.get('executableSha256')
    matching = [row for row in files if
                (row['path'].casefold() if target == 'windows-x86_64' else row['path']) == executable_path]
    executable = matching[0] if len(matching) == 1 else None
    if not executable or executable['sha256'] != executable_hash:
        raise ValueError('core entrypoint scan does not identify the inventoried executable')
    arguments = evidence.get('moduleReexecArguments')
    if (not isinstance(arguments, dict) or arguments.keys() != set(MODULE_REEXEC_ARGUMENTS)
            or any(type(present) is not bool for present in arguments.values())):
        raise ValueError('core executable lacks a complete module re-exec argument scan')
    if arguments['--vnc-special-key-hook']:
        raise ValueError('core executable contains the retired --vnc-special-key-hook argument')
    # The macOS core passes the bridge argument to the verified SocksCap host.
    # Its presence in the executable records that string, not a core handler.

    baseline = json.loads((directory / 'bundle-baseline.json').read_text(encoding='utf-8'))
    if baseline['target'] != target:
        raise ValueError('core payload source target differs from the inspected package')
    suffix = TARGETS[target][1][0]  # The deb, MSI or DMG inspected by the platform adapter.
    package, = (asset for asset in baseline['files'] if asset['name'].endswith(suffix))
    runner = json.loads((directory / 'runner.json').read_text(encoding='utf-8'))
    write_json(directory / 'core-payload-receipt.json', {
        'schema': 'taomni.core-payload-inventory.v1', 'target': target, 'package': package,
        'producerSource': baseline['producerSource'], 'producerRun': baseline['producerRun'],
        'toolingSource': baseline['toolingSource'], 'runner': runner,
        'rawArtifact': f'modular-bundle-{target}-{baseline["producerRun"]}/{name}',
        'rawSha256': digest(raw), 'regularFiles': len(files),
        'executableSha256': executable_hash, 'moduleReexecArguments': arguments,
    })


def linux_metadata(directory: Path, output: Path, version: str) -> dict:
    deb = next(directory.glob('*.deb'))
    fields = {}
    for field in ('Package', 'Version', 'Architecture', 'Installed-Size', 'Depends'):
        fields[field] = subprocess.check_output(
            ['dpkg-deb', '--field', str(deb), field], text=True).strip()
    write_json(output / 'deb-fields.json', fields)
    if fields['Version'] != version or fields['Architecture'] != 'amd64':
        raise ValueError('Debian payload version/architecture differs')
    with (output / 'deb-contents.log').open('w', encoding='utf-8') as stream:
        subprocess.run(['dpkg-deb', '--contents', str(deb)], stdout=stream, check=True)
    rpm = next(directory.glob('*.rpm'))
    with (output / 'rpm-info.log').open('w', encoding='utf-8') as stream:
        subprocess.run(['rpm', '-qip', str(rpm)], stdout=stream,
                       stderr=subprocess.STDOUT, check=True)
    with tempfile.TemporaryDirectory(prefix='taomni-deb-payload-') as work:
        payload = Path(work)
        subprocess.run(['dpkg-deb', '--extract', str(deb), str(payload)], check=True)
        binary = payload / 'usr/bin/taomni'
        if not binary.is_file() or binary.is_symlink():
            raise ValueError('expected an actual taomni executable in Debian payload')
        write_json(output / 'linux-payload.json', {
            'scope': 'deb-extracted-payload', 'executableSha256': digest(binary),
            'moduleReexecArguments': module_reexec_arguments(binary),
            'payload': tree_sample(payload), 'applicationLaunched': False,
            'installedUpgradeEstablished': False, 'systemTrustEstablished': False,
        })
        with (output / 'deb-executable-header.log').open('w', encoding='utf-8') as stream:
            subprocess.run(['readelf', '--file-header', str(binary)], stdout=stream, check=True)
    return fields


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan-targets')
    plan.add_argument('--targets', required=True)
    plan.add_argument('--upgrade-desktop', action='store_true')
    plan.add_argument('--include-linux-inventory', action='store_true')
    plan.add_argument('--macos-arm-runner', default='macos-15', choices=('macos-15', 'macos-26'))
    plan.add_argument('--github-output', type=Path, required=True)
    payload = commands.add_parser('validate-payload')
    payload.add_argument('--target', required=True)
    payload.add_argument('--directory', type=Path, required=True)
    tree = commands.add_parser('sample-tree')
    tree.add_argument('--root', type=Path, required=True)
    entrypoints = commands.add_parser('module-reexec-arguments')
    entrypoints.add_argument('--executable', type=Path, required=True)
    validate = commands.add_parser('validate-source')
    for key in ('run', 'artifacts', 'out', 'github-output'):
        validate.add_argument(f'--{key}', type=Path, required=True)
    for key in ('repository', 'run-id', 'source', 'version', 'target'):
        validate.add_argument(f'--{key}', required=True)
    collect = commands.add_parser('inventory')
    for key in ('directory', 'identity', 'out'):
        collect.add_argument(f'--{key}', type=Path, required=True)
    collect.add_argument('--tooling-source', required=True)
    collect.add_argument('--linux-metadata', action='store_true')
    args = parser.parse_args()
    if args.command == 'plan-targets':
        matrix = plan_targets(args.targets, upgrade_desktop=args.upgrade_desktop,
                              include_linux_inventory=args.include_linux_inventory, macos_arm_runner=args.macos_arm_runner)
        with args.github_output.open('a', encoding='utf-8') as stream:
            stream.write('matrix=' + json.dumps(matrix, separators=(',', ':')) + '\n')
            if args.upgrade_desktop:
                builds = {"include": [
                    {"platform_key": "windows" if entry["target"].startswith("windows-") else "macos",
                     "arch": "ARM64" if entry["target"].endswith("-aarch64") else "X64",
                     "capabilities": ["signed-mfa"]}
                    for entry in matrix["include"]
                    if not entry["target"].startswith("linux-")
                ]}
                stream.write('mfa_builds=' + json.dumps(builds, separators=(',', ':')) + '\n')
        return
    if args.command == 'sample-tree':
        print(json.dumps(tree_sample(args.root)))
        return
    if args.command == 'module-reexec-arguments':
        print(json.dumps(module_reexec_arguments(args.executable)))
        return
    if args.command == 'validate-payload':
        record_payload_receipt(args.target, args.directory)
        return
    if args.command == 'validate-source':
        record = validate_source(
            json.loads(args.run.read_text(encoding='utf-8')),
            json.loads(args.artifacts.read_text(encoding='utf-8')),
            repository=args.repository, run_id=args.run_id, source=args.source,
            version=args.version, target=args.target)
        write_json(args.out, record)
        with args.github_output.open('a', encoding='utf-8') as stream:
            stream.write(f"artifact_id={record['artifact']['id']}\n")
        return
    identity = json.loads(args.identity.read_text(encoding='utf-8'))
    result = inventory(args.directory, identity)
    result['toolingSource'] = args.tooling_source
    write_json(args.out / 'bundle-baseline.json', result)
    if args.linux_metadata:
        linux_metadata(args.directory, args.out, identity['version'])
    print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
