"""Stage and verify the pinned Xray binary and license for the SocksCap release."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


RESOURCE = Path("resources/xray")


def pin(source: Path, platform: str):
    release = json.loads((source / RESOURCE / "release.json").read_text(encoding="utf-8"))
    binary = "xray.exe" if platform.startswith("windows-") else "xray"
    return release, release["platforms"][platform], binary


def digest(path: Path):
    sha256 = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha256.update(block)
    return sha256.hexdigest()


def verify(source: Path, platform: str, payload: Path):
    release, target, binary = pin(source, platform)
    directory = payload / RESOURCE
    expected = {binary: target["binarySha256"], "LICENSE": release["licenseSha256"]}
    if directory.is_symlink() or {entry.name for entry in directory.iterdir()} != set(expected):
        raise ValueError("SocksCap package must contain exactly Xray and its license for the target")
    for name, sha256 in expected.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != sha256:
            raise ValueError(f"Xray {name} differs from the pinned upstream release")


def stage(source: Path, platform: str, payload: Path, archive: Path | None = None):
    release, target, binary = pin(source, platform)
    with tempfile.TemporaryDirectory(prefix="taomni-xray-") as work:
        work = Path(work)
        if archive is None:
            archive = work / target["archive"]
            url = f'{release["repository"]}/releases/download/{release["version"]}/{target["archive"]}'
            subprocess.run(
                ["curl", "-fLsS", "--retry", "3", "--connect-timeout", "15", "--max-time", "180",
                 "-o", str(archive), url], check=True,
            )
        if digest(archive) != target["archiveSha256"]:
            raise ValueError(f'Unexpected SHA-256 for {target["archive"]}')
        directory = work / RESOURCE
        directory.mkdir(parents=True)
        with zipfile.ZipFile(archive) as packed:
            for member in (binary, "LICENSE"):
                with packed.open(member) as source_file, (directory / member).open("xb") as destination:
                    shutil.copyfileobj(source_file, destination)
        verify(source, platform, work)
        (payload / RESOURCE).parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(directory, payload / RESOURCE)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("stage", "verify"))
    parser.add_argument("source", type=Path)
    parser.add_argument("platform")
    parser.add_argument("payload", type=Path)
    args = parser.parse_args()
    (stage if args.operation == "stage" else verify)(args.source, args.platform, args.payload)
