"""Immutable, public installer inputs for hosted upgrade verification."""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import platform
import time
import urllib.request


@dataclass(frozen=True)
class ReleaseAsset:
    asset_id: int
    name: str
    size: int
    sha256: str


RELEASE_ID = 449346766
RELEASE_VERSION = "0.5.10"
RELEASE_TAG = f"v{RELEASE_VERSION}"
ASSETS = {
    ("Linux", "x64"): ReleaseAsset(
        761457345, "Taomni_0.5.10_amd64.deb", 109669490,
        "3667b1fd0983660c636b4c0bdcaea9759e40174a87ab0ccbecaaaa69046d9a0a"),
    ("Windows", "x64"): ReleaseAsset(
        761458084, "Taomni_0.5.10_x64_en-US.msi", 96120832,
        "bc83c2aa84852443b4f42fe87be95051f010baa7bb12ae82501db7611a36fb22"),
    ("Darwin", "arm64"): ReleaseAsset(
        761456797, "Taomni_0.5.10_aarch64.dmg", 98516008,
        "3044a7ee96e3a36ba4cbc8305a6777db1c96c7ffabed3e8b3aa6fa8c90ebe153"),
    ("Darwin", "x64"): ReleaseAsset(
        761457841, "Taomni_0.5.10_x64.dmg", 104617072,
        "6cdd181a6ea61a370661cd9ee84ec368f9c71279e916558d780ac9fd0dcc658d"),
}


def selected_asset(system=None, machine=None):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    try:
        return ASSETS[(system, arch)]
    except KeyError:
        raise RuntimeError(f"No pinned {RELEASE_VERSION} installer for {system}/{machine}") from None


def verify_asset(path, asset):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != asset.size:
        raise RuntimeError("Legacy installer is missing, linked or has the wrong size")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != asset.sha256:
        raise RuntimeError("Legacy installer SHA-256 does not match the pinned release")


def download_asset(directory, asset):
    """Never install a partial, redirected-to-HTML or substituted release asset."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    completed = directory / asset.name
    if completed.exists():
        verify_asset(completed, asset)
        return completed
    partial = completed.with_suffix(completed.suffix + ".partial")
    if partial.is_symlink():
        raise RuntimeError("Legacy download refuses a linked partial file")
    url = f"https://github.com/engcapa/taomni/releases/download/{RELEASE_TAG}/{asset.name}"
    request = urllib.request.Request(url, headers={"User-Agent": "Taomni-hosted-upgrade-QA"})
    deadline = time.monotonic() + 240
    try:
        with urllib.request.urlopen(request, timeout=30) as response, partial.open("xb") as output:
            if response.status != 200 or not response.url.startswith("https://"):
                raise RuntimeError("Legacy release download did not return a full HTTPS response")
            downloaded = 0
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > asset.size or time.monotonic() > deadline:
                    raise RuntimeError("Legacy release download exceeded its size/time bound")
                output.write(chunk)
        verify_asset(partial, asset)
        partial.replace(completed)
        return completed
    finally:
        partial.unlink(missing_ok=True)
