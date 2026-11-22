"""Save third-party Cargo intermediates for successive builds of a QA branch."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib

from native_build import ROOT, configured_environment
from qa_ui_auto.provenance import digest_file, fingerprint, repository_files

ARCHIVE_NAME = "dependencies.tar.gz"
PROFILE_DIRS = (".fingerprint", "build", "deps")
TARGET = ROOT / "src-tauri/target/qa-ui-auto"
MANIFEST = ROOT / "src-tauri/Cargo.toml"
LOCK = MANIFEST.with_name("Cargo.lock")
SHERPA = "sherpa-onnx-prebuilt"


def cargo_manifests(root: Path) -> list[str]:
    return [name for name in repository_files(root)
            if name.startswith("src-tauri/") and name.endswith("/Cargo.toml")]


def cache_key(profile: str, runner: str) -> str:
    env = configured_environment()
    files = cargo_manifests(ROOT) + [
        "src-tauri/Cargo.lock", ".cargo/config", ".cargo/config.toml",
        "src-tauri/.cargo/config", "src-tauri/.cargo/config.toml",
        "rust-toolchain", "rust-toolchain.toml", "src-tauri/rust-toolchain", "src-tauri/rust-toolchain.toml",
    ]
    inputs = {
        "manifests": fingerprint(ROOT, files),
        "profile": profile,
        "runner": runner,
        "image": env.get("ImageVersion") or env.get("IMAGEVERSION"),
        "rustc": subprocess.check_output(["rustc", "-vV"], env=env, text=True).strip(),
        "cargo": subprocess.check_output(["cargo", "-V"], env=env, text=True).strip(),
        "environment": {key: value for key, value in env.items() if key in {
            "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET", "CC", "CXX",
            "CFLAGS", "CXXFLAGS", "LIBCLANG_PATH", "PKG_CONFIG_PATH", "LIBRARY_PATH",
        } or key.startswith(("CARGO_PROFILE_", "BINDGEN_EXTRA_CLANG_ARGS", "CMAKE_"))},
    }
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    return f"qa-cargo-dependencies-v1-{runner}-{profile}-{digest}"


def local_units(root: Path) -> set[str]:
    units = set()
    for name in cargo_manifests(root):
        data = tomllib.loads((root / name).read_text(encoding="utf-8"))
        package = data.get("package", {}).get("name")
        if package:
            units.add(package)
        for target in [data.get("lib", {}), *data.get("bin", [])]:
            if "name" in target:
                units.add(target["name"])
    units |= {name.replace("-", "_") for name in units}
    return units | {f"lib{name}" for name in units}


def _is_local_unit(filename: str, units: set[str]) -> bool:
    unit = re.split(r"-[a-f0-9]{16}(?:\b|_)", filename, maxsplit=1)[0]
    return unit in units


def _plain_member(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    return member if member.isfile() or member.isdir() else None


def pack(destination: Path, profile: str, *, target: Path, cargo_home: Path, units: set[str]) -> None:
    if not all((target / profile / directory).is_dir() for directory in PROFILE_DIRS):
        raise ValueError(f"missing Cargo output for {profile}")
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / ARCHIVE_NAME
    with tarfile.open(archive, "w:gz", compresslevel=1) as stream:
        for directory in PROFILE_DIRS:
            base = target / profile / directory
            prefix = f"target/{profile}/{directory}"
            stream.add(base, prefix, recursive=False)
            for path in sorted(base.iterdir()):
                if not _is_local_unit(path.name, units):
                    stream.add(path, f"{prefix}/{path.name}", filter=_plain_member)
        if (target / SHERPA).is_dir():
            stream.add(target / SHERPA, f"target/{SHERPA}", filter=_plain_member)
        # Build scripts of *-sys crates can depend on the source mtimes. Cargo
        # can recreate the other unpacked registries from their .crate files.
        registry = cargo_home / "registry"
        locked = tomllib.loads(LOCK.read_text(encoding="utf-8"))["package"]
        packages = {f"{p['name']}-{p['version']}" for p in locked if p.get("source", "").startswith("registry+")}
        sys_packages = {f"{p['name']}-{p['version']}" for p in locked if p["name"].endswith("-sys")}
        for directory, names in (("cache", {f"{name}.crate" for name in packages}), ("src", sys_packages)):
            for path in sorted((registry / directory).glob("*/*")):
                if path.name in names:
                    stream.add(path, path.relative_to(cargo_home).as_posix(), filter=_plain_member)
    destination.joinpath("sha256").write_text(digest_file(archive) + "\n", encoding="ascii")


def _allowed(member: tarfile.TarInfo, profile: str) -> bool:
    name = PurePosixPath(member.name)
    parts = name.parts
    if not _plain_member(member) or name.is_absolute() or ".." in parts or "\\" in member.name or ":" in member.name:
        return False
    return (parts[:2] == ("target", SHERPA)
            or parts[:2] == ("target", profile) and len(parts) >= 3 and parts[2] in PROFILE_DIRS
            or parts[:2] in (("registry", "cache"), ("registry", "src")) and len(parts) >= 4)


def restore(source: Path, profile: str, *, target: Path, cargo_home: Path) -> bool:
    archive = source / ARCHIVE_NAME
    if source.joinpath("sha256").read_text(encoding="ascii").strip() != digest_file(archive):
        raise ValueError("Cargo dependency archive checksum differs")
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as staging, tarfile.open(archive, "r:gz") as stream:
        staging = Path(staging)
        members = stream.getmembers()
        names = {PurePosixPath(member.name).as_posix() for member in members}
        if not members or len(names) != len(members) or any(not _allowed(member, profile) for member in members):
            raise ValueError("unexpected Cargo dependency archive contents")
        stream.extractall(staging, members=members, filter="data")
        for directory in PROFILE_DIRS:
            if not (staging / "target" / profile / directory).is_dir():
                raise ValueError(f"missing Cargo archive directory {directory}")
        for path in (staging / "target").iterdir():
            destination = target / path.name
            if destination.exists():
                shutil.copytree(path, destination, dirs_exist_ok=True)
            else:
                path.replace(destination)
        if (staging / "registry").is_dir():
            shutil.copytree(staging / "registry", cargo_home / "registry", dirs_exist_ok=True)
    print(f"Restored Cargo {profile} dependency intermediates from this branch")
    return (target / SHERPA).is_dir()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("key", "pack", "restore"))
    args = parser.parse_args()
    profile = os.environ["QA_CARGO_PROFILE"]
    if profile not in {"debug", "release"}:
        parser.error("unsupported Cargo profile")
    output = Path(os.environ["GITHUB_OUTPUT"])
    if args.operation == "key":
        with output.open("a", encoding="utf-8") as file:
            file.write(f"name={cache_key(profile, os.environ['QA_CARGO_RUNNER'])}\n")
        return
    directory = Path(os.environ["QA_CARGO_ARCHIVE"])
    cargo_home = Path(os.environ.get("CARGO_HOME") or Path.home() / ".cargo")
    if args.operation == "pack":
        pack(directory, profile, target=TARGET, cargo_home=cargo_home, units=local_units(ROOT))
    else:
        sherpa = restore(directory, profile, target=TARGET, cargo_home=cargo_home)
        with output.open("a", encoding="utf-8") as file:
            file.write(f"sherpa-hit={str(sherpa).lower()}\n")


if __name__ == "__main__":
    main()
