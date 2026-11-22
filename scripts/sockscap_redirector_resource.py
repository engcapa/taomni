"""Package the upstream-signed installer with the macOS SocksCap module."""

import hashlib
import json
from pathlib import Path
import shutil


RESOURCE = Path("resources/macos/redirector/0.12.11")
ARCHIVE = "Mitmproxy Redirector.app.tar"
FILES = (ARCHIVE, "manifest.json", "LICENSE")


def files(slug, platform):
    if slug == "sockscap" and platform in {"darwin-aarch64", "darwin-x86_64"}:
        return tuple((RESOURCE / name).as_posix() for name in FILES)
    return ()


def stage(slug, platform, source: Path, payload: Path):
    for name in files(slug, platform):
        target = payload / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)


def verify(slug, platform, source: Path, payload: Path):
    expected = files(slug, platform)
    directory = payload / RESOURCE
    if not expected:
        if directory.exists() or directory.is_symlink():
            raise ValueError("Unexpected macOS Redirector resource for this module target")
        return
    if {p.name for p in directory.iterdir()} != set(FILES):
        raise ValueError("Incomplete or unexpected macOS Redirector payload")
    manifest = json.loads((source / RESOURCE / "manifest.json").read_text(encoding="utf-8"))
    for name in expected:
        file = payload / name
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Missing macOS Redirector file: {name}")
        if file.name == ARCHIVE:
            with file.open("rb") as archive:
                matches = hashlib.file_digest(archive, "sha256").hexdigest() == manifest["appTarSha256"]
        else:
            matches = file.read_bytes() == (source / name).read_bytes()
        if not matches:
            raise ValueError(f"macOS Redirector differs from the pinned release: {name}")
