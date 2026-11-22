"""Stage the Windows SocksCap capture helper and the approved WinDivert runtime."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

from sockscap_xray_resource import digest

RESOURCE = Path("resources/windows")
HELPER = "sockscap-helper.exe"


def pinned_release(source: Path):
    return json.loads((source / RESOURCE / "windivert-release.json").read_text(encoding="utf-8"))


def files(source: Path):
    return {(RESOURCE / name).as_posix() for name in (HELPER, *pinned_release(source)["files"])}


def verify(source: Path, payload: Path):
    pin = pinned_release(source)
    directory = payload / RESOURCE
    if directory.is_symlink() or {path.name for path in directory.iterdir()} != {HELPER, *pin["files"]}:
        raise ValueError("Unexpected Windows SocksCap capture payload")
    for name, facts in pin["files"].items():
        file = directory / name
        if file.is_symlink() or not file.is_file() or digest(file) != facts["sha256"]:
            raise ValueError(f"{name} differs from the pinned WinDivert release")
    helper = directory / HELPER
    if helper.is_symlink() or not helper.is_file():
        raise ValueError("Windows SocksCap helper is missing")
    with helper.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Windows SocksCap helper is not a PE executable")


def stage(source: Path, payload: Path, helper: Path, archive: Path):
    pin = pinned_release(source)
    directory = payload / RESOURCE
    if digest(archive) != pin["archiveSha256"]:
        raise ValueError("WinDivert archive differs from the pinned SHA-256")
    directory.mkdir(parents=True)
    shutil.copyfile(helper, directory / HELPER)
    with zipfile.ZipFile(archive) as packed:
        for name, facts in pin["files"].items():
            with packed.open(facts["member"]) as entry, (directory / name).open("xb") as file:
                shutil.copyfileobj(entry, file)
    verify(source, payload)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("payload", type=Path)
    parser.add_argument("--helper", type=Path, help="Build output used when staging")
    args = parser.parse_args()
    if args.helper:
        pin = pinned_release(args.source)
        with tempfile.TemporaryDirectory(prefix="taomni-windivert-") as work:
            archive = Path(work) / "WinDivert.zip"
            subprocess.run(
                ["curl", "-fLsS", "--retry", "3", "--connect-timeout", "15", "--max-time", "120",
                 "-o", str(archive), pin["url"]], check=True,
            )
            stage(args.source, args.payload, args.helper, archive)
    else:
        verify(args.source, args.payload)
