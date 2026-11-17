"""Immutable, public 0.5.9 installer inputs for hosted upgrade verification."""
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


RELEASE_ID = 443581958
RELEASE_TAG = "v0.5.9"
ASSETS = {
    ("Linux", "x64"): ReleaseAsset(
        741932993, "Taomni_0.5.9_amd64.deb", 106131316,
        "f62218535835d6103f0c51d9cfdc7baf29a148981031965425025c53eaa0b00c"),
    ("Windows", "x64"): ReleaseAsset(
        741933721, "Taomni_0.5.9_x64_en-US.msi", 92921856,
        "dfdb0b246808768dd46469d3e64872994d0ee61068a34d15ab1bc567cf2faa8e"),
    ("Darwin", "arm64"): ReleaseAsset(
        741932423, "Taomni_0.5.9_aarch64.dmg", 95259547,
        "61351e3dc809a356fd59584275baae86aceaac858b11c09813f8be70605daafa"),
    ("Darwin", "x64"): ReleaseAsset(
        741933471, "Taomni_0.5.9_x64.dmg", 101233955,
        "f0b558fc38b63791b22685c320c4b269cce8df7e2c80054b762f27ee80f8320b"),
}


def selected_asset(system=None, machine=None):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    try:
        return ASSETS[(system, arch)]
    except KeyError:
        raise RuntimeError(f"No pinned 0.5.9 installer for {system}/{machine}") from None


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
