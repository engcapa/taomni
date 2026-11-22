"""Immutable, public installer inputs for hosted upgrade verification."""
from dataclasses import dataclass
import argparse
import hashlib
import os
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
        761714749, "Taomni_0.5.10_amd64.deb", 109669454,
        "237b5b3ae296e74d3227d9c1135d72caa189eb5fd41be7fb0042016bc39adb8a"),
    ("Windows", "x64"): ReleaseAsset(
        761715464, "Taomni_0.5.10_x64_en-US.msi", 96120832,
        "8b51c045c09a3411a4bd3a44613c48bb4e50192a5eaa4f6d0cf91e5135921237"),
    ("Darwin", "arm64"): ReleaseAsset(
        761714079, "Taomni_0.5.10_aarch64.dmg", 98517685,
        "d5a78bddf9d71a4cce9ba57c3b744f14878806eece0283e181b0a48891645dab"),
    ("Darwin", "x64"): ReleaseAsset(
        761715279, "Taomni_0.5.10_x64.dmg", 104617252,
        "e6f8f3eb7f4f3af4e29e53d7870bc48a55a9d0b34de05724ced95e62a4514e2c"),
}


FIRST_UPGRADE_VERSION = "0.5.12"
FIRST_UPGRADE_ASSETS = {
    ("Linux", "x64"): ReleaseAsset(
        778140971, "Taomni_0.5.12_amd64.deb", 111121068,
        "f832e8a8c4831fba93f7ccce3142b9fd897fccd078a652147cba2fa2a216528a"),
    ("Windows", "x64"): ReleaseAsset(
        778141256, "Taomni_0.5.12_x64_en-US.msi", 97583104,
        "5b02169cb3cd4d4700fd98c397b3dbad1ef81604a18d617e9573dfd4cba2fd2c"),
    ("Darwin", "arm64"): ReleaseAsset(
        778140588, "Taomni_0.5.12_aarch64.dmg", 101059589,
        "e2f3305d5f7b8a8c40fbc874af920cc9e1df6a1608e0f75d9a923b2a26d2f902"),
    ("Darwin", "x64"): ReleaseAsset(
        778141173, "Taomni_0.5.12_x64.dmg", 107199989,
        "5c1912e553fe9246ddaf81e250b1a6b50eff229081e13e463c33ad4b1a68d297"),
}
RELEASES = {
    RELEASE_VERSION: (RELEASE_ID, ASSETS),
    FIRST_UPGRADE_VERSION: (454210401, FIRST_UPGRADE_ASSETS),
}


def selected_asset(system=None, machine=None, *, version=RELEASE_VERSION):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    try:
        return RELEASES[version][1][(system, arch)]
    except KeyError:
        raise RuntimeError(f"No pinned {version} installer for {system}/{machine}") from None


def verify_asset(path, asset):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != asset.size:
        raise RuntimeError("Legacy installer is missing, linked or has the wrong size")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != asset.sha256:
        raise RuntimeError("Legacy installer SHA-256 does not match the pinned release")


def download_asset(directory, asset, *, token=None):
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
    url = f"https://api.github.com/repos/engcapa/taomni/releases/assets/{asset.asset_id}?download=1"
    request = urllib.request.Request(url, headers={
        "User-Agent": "Taomni-hosted-upgrade-QA",
        "Accept": "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    if token:
        request.add_unredirected_header("Authorization", f"Bearer {token}")
    deadline = time.monotonic() + 240
    try:
        with urllib.request.urlopen(request, timeout=30) as response, partial.open("xb") as output:
            if response.status != 200 or not response.url.startswith("https://"):
                raise RuntimeError("Legacy release download did not return a full HTTPS response")
            if response.headers.get_content_type() in {"application/json", "text/html"}:
                raise RuntimeError(f"GitHub did not return the pinned legacy asset {asset.asset_id}")
            length = response.headers.get("Content-Length")
            if length is not None and length != str(asset.size):
                raise RuntimeError(f"Legacy asset {asset.asset_id} has Content-Length {length}, expected {asset.size}")
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version", choices=RELEASES, default=RELEASE_VERSION)
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("Provide the hosted installer staging directory and a read-only GH_TOKEN")
    asset = selected_asset(version=args.version)
    download_asset(args.directory, asset, token=token)
    print(f"Verified {asset.name} (asset {asset.asset_id}, SHA-256 {asset.sha256})")


if __name__ == "__main__":
    main()
