"""Transfer a QA runtime between jobs, binding every byte to this invocation.

Cargo intermediates are deliberately excluded. Original build inputs/identity
are retained; importing does not forge a new build or relax local cache checks.
"""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import tarfile
import tempfile

import native_build
from qa_ui_auto.ci import commit, selection_digest
from qa_ui_auto.provenance import execution_identity

ROOT = native_build.ROOT
MANIFEST = 'qa-runtime.json'


def build_entry(selection, build_id):
    matches = [b for b in selection['builds'] if b['id'] == build_id]
    if len(matches) != 1:
        raise ValueError('unknown/duplicate native build')
    return matches[0]


def allowed(name, profile):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
        return False
    return name.startswith(f'src-tauri/target/qa-ui-auto/{profile}/') or name.startswith('src-tauri/frameworks/')


def export(archive, selection, entry):
    if commit('HEAD') != selection['head'] or execution_identity(ROOT) != selection['identity']:
        raise ValueError('build checkout differs from selection')
    profile = entry['profile']
    binary = native_build.qa_binary(release=profile == 'release')
    identity = native_build.verify_identity(binary)
    if identity['source_sha256'] != selection['identity']['source_sha256']:
        raise ValueError('native build source differs')
    # Immediate runtime files and resource trees; never Cargo object caches.
    excluded = {'deps', 'build', 'incremental', '.fingerprint', 'examples', 'bundle'}
    paths = []
    for child in sorted(binary.parent.iterdir()):
        if child.name in excluded or child.name.startswith('.'):
            continue
        if child.is_file() and child.suffix in {'.d', '.rlib', '.a', '.lib', '.pdb', '.exp'}:
            continue
        paths.extend(p for p in ([child] if child.is_file() else child.rglob('*')) if p.is_file())
    frameworks = ROOT / 'src-tauri/frameworks'
    if frameworks.exists():
        paths.extend(p for p in frameworks.rglob('*') if p.is_file())
    names = {p.relative_to(ROOT).as_posix(): p for p in paths}
    required = [binary.relative_to(ROOT).as_posix(), native_build.identity_path(binary).relative_to(ROOT).as_posix()]
    if not set(required) <= names.keys():
        raise ValueError('missing required runtime files')
    record = {'schema': 1, 'build_id': entry['id'], 'head': selection['head'],
              'selection_sha256': selection_digest(selection), 'platform': platform.system(),
              'arch': entry['arch'], 'runner': entry['runner'], 'profile': profile,
              'identity': selection['identity'], 'binary': required[0],
              'files': {n: {'sha256': native_build.binary_digest(p), 'mode': p.stat().st_mode & 0o777}
                        for n, p in sorted(names.items())}}
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'w:gz', dereference=True) as tar:
        for name, path in sorted(names.items()):
            if not allowed(name, profile):
                raise ValueError('invalid runtime path')
            tar.add(path, arcname=name, recursive=False)
        data = json.dumps(record, sort_keys=True).encode()
        info = tarfile.TarInfo(MANIFEST); info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    print(f'Exported {len(names)} runtime files for {entry["id"]}: {archive}', flush=True)


def install(archive, selection, entry):
    build = build_entry(selection, entry['build_id'])
    arch = {'amd64': 'X64', 'x86_64': 'X64', 'arm64': 'ARM64', 'aarch64': 'ARM64'}.get(platform.machine().lower())
    with tarfile.open(archive, 'r:gz') as tar, tempfile.TemporaryDirectory() as directory:
        members = tar.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or MANIFEST not in names:
            raise ValueError('duplicate or missing runtime manifest')
        record = json.load(tar.extractfile(MANIFEST))
        expected = {'schema': 1, 'build_id': entry['build_id'], 'head': selection['head'],
                    'selection_sha256': selection_digest(selection), 'platform': platform.system(),
                    'arch': arch, 'runner': entry['runner'], 'profile': build['profile'],
                    'identity': selection['identity']}
        if any(record.get(k) != v for k, v in expected.items()):
            raise ValueError('native artifact identity differs from selection/platform/profile')
        if commit('HEAD') != selection['head'] or execution_identity(ROOT) != selection['identity']:
            raise ValueError('runtime checkout differs from selection')
        if set(names) != set(record['files']) | {MANIFEST}:
            raise ValueError('runtime file list differs')
        staged = Path(directory)
        # Validate the entire archive before publishing anything. No tar path,
        # link, device or unverified sidecar can escape the declared roots.
        for m in members:
            if not m.isfile():
                raise ValueError('runtime archive must contain only regular files')
            if m.name == MANIFEST:
                continue
            if not allowed(m.name, build['profile']):
                raise ValueError('unsafe runtime path')
            target = staged / m.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(m) as source, target.open('wb') as dest:
                shutil.copyfileobj(source, dest)
            if native_build.binary_digest(target) != record['files'][m.name]['sha256']:
                raise ValueError('runtime checksum differs: ' + m.name)
            target.chmod(record['files'][m.name]['mode'] & 0o777)
        binary_name = record['binary']
        expected_binary = native_build.qa_binary(release=build['profile'] == 'release').relative_to(ROOT).as_posix()
        if binary_name != expected_binary:
            raise ValueError('runtime binary path differs')
        identity = native_build.verify_identity(staged / binary_name)
        if identity['source_sha256'] != selection['identity']['source_sha256'] or identity['profile'] != build['profile']:
            raise ValueError('original QA build record differs')
        for name in record['files']:
            dest = ROOT / name
            if dest.resolve() != dest.absolute():
                raise ValueError('runtime destination must not be a symlink')
        for name in record['files']:
            dest = ROOT / name; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(staged / name, dest)
    print(f'Installed verified native build {entry["build_id"]}; no compilation', flush=True)
    return record


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--selection', type=Path, required=True)
    ap.add_argument('--build', required=True)
    ap.add_argument('--archive', type=Path, required=True)
    args = ap.parse_args()
    selection = json.loads(args.selection.read_text(encoding='utf-8'))
    entry = build_entry(selection, args.build)
    native_build.build_qa(release=entry['profile'] == 'release')
    export(args.archive, selection, entry)


if __name__ == '__main__':
    main()
