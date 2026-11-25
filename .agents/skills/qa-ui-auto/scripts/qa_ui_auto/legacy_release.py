"""Immutable, public installer inputs for hosted upgrade verification."""
from dataclasses import dataclass
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import time
import urllib.request

from . import legacy_baseline


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


ASSETS_0_5_12 = {
    ("Linux", "x64"): ReleaseAsset(
        778338425, "Taomni_0.5.12_amd64.deb", 111121038,
        "eacf3848a7378d590a7e9724912824d8affcb69b484d060927db0809cce09f3e"),
    ("Windows", "x64"): ReleaseAsset(
        778338806, "Taomni_0.5.12_x64_en-US.msi", 97587200,
        "850bd681779d4996684e82963459001051fe03df770682d5b13510516a16421f"),
    ("Darwin", "arm64"): ReleaseAsset(
        778338053, "Taomni_0.5.12_aarch64.dmg", 101059621,
        "b8f639710020ae5a407e45d09797c6930facd20a6c28cecb88a33240f672dc96"),
    ("Darwin", "x64"): ReleaseAsset(
        778338688, "Taomni_0.5.12_x64.dmg", 107200003,
        "78088495bc7cb2a9a8d44bc4dd74b7a96e5352a4e0c3a7f70f68c0b1cc306660"),
}
ASSETS_0_5_13 = {
    ("Linux", "x64"): ReleaseAsset(
        784345275, "Taomni_0.5.13_amd64.deb", 110933198,
        "73e8c7e7d48aea1d3c95156cbf66c63fce55316fc4e3232035bad275fbd43164"),
    ("Windows", "x64"): ReleaseAsset(
        784346039, "Taomni_0.5.13_x64_en-US.msi", 97116160,
        "52d8df192c8d55e3c252600eed6394596ed04c0f5ffd063ec31504a1b5453adc"),
    ("Darwin", "arm64"): ReleaseAsset(
        784344768, "Taomni_0.5.13_aarch64.dmg", 100877734,
        "34221d943df68e979d0c6116b7b43ac1230d84095be128e0b02d6717682b354d"),
    ("Darwin", "x64"): ReleaseAsset(
        784345691, "Taomni_0.5.13_x64.dmg", 106995715,
        "5ae9e9430e1cb1a7dc6c3bb440a7ed3af97042f627fdfe1635cd1abd73ad6b82"),
}
RELEASES = {
    RELEASE_VERSION: (RELEASE_ID, ASSETS),
    "0.5.12": (454210401, ASSETS_0_5_12),
    "0.5.13": (455671999, ASSETS_0_5_13),
}


def first_upgrade_version():
    return legacy_baseline.current()["version"]


def release_assets(version):
    if version in RELEASES and not (os.environ.get("QA_FIRST_UPGRADE_BASELINE")
                                    or os.environ.get("QA_FIRST_UPGRADE_BASELINE_FILE")):
        return RELEASES[version]
    if version == "latest":
        raise RuntimeError("No pinned installer for the literal version latest")
    record = legacy_baseline.current()
    if record["version"] != version:
        if version in RELEASES:
            return RELEASES[version]
        raise RuntimeError("Requested installer differs from the first-upgrade baseline")
    assets = {tuple(target.split("/")): ReleaseAsset(**values) for target, values in record["installers"].items()}
    if version in RELEASES and (record["releaseId"], assets) != RELEASES[version]:
        raise RuntimeError("Public installer identity differs from its historical pin")
    return record["releaseId"], assets


def selected_asset(system=None, machine=None, *, version=RELEASE_VERSION):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    try:
        return release_assets(version)[1][(system, arch)]
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
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--version", choices=RELEASES, default=RELEASE_VERSION)
    inputs.add_argument("--first-upgrade", action="store_true",
                        help="Use the pinned first-upgrade baseline selected by QA_FIRST_UPGRADE_VERSION")
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("Provide the hosted installer staging directory and a read-only GH_TOKEN")
    if args.first_upgrade:
        record = legacy_baseline.current()
        args.directory.mkdir(parents=True, exist_ok=True)
        receipt = (args.directory / "first-upgrade-baseline.json").resolve()
        receipt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        os.environ["QA_FIRST_UPGRADE_BASELINE_FILE"] = str(receipt)
        github_env = os.environ.get("GITHUB_ENV")
        if github_env:
            with Path(github_env).open("a", encoding="utf-8") as output:
                output.write(f"QA_FIRST_UPGRADE_BASELINE_FILE={receipt}\n")
    asset = selected_asset(version=record["version"] if args.first_upgrade else args.version)
    download_asset(args.directory, asset, token=token)
    print(f"Verified {asset.name} (asset {asset.asset_id}, SHA-256 {asset.sha256})")


if __name__ == "__main__":
    main()
