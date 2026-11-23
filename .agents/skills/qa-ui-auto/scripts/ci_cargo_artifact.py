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
VENDOR_PREFIX = "src-tauri/vendor/"
DEFAULT_VENDOR_MTIME_EPOCH = 1_600_000_000


def cargo_manifests(root: Path) -> list[str]:
    return [name for name in repository_files(root)
            if name.startswith("src-tauri/") and name.endswith("/Cargo.toml")]


def vendor_manifests(root: Path) -> list[str]:
    """Return the repository-relative manifests vendored under src-tauri/vendor."""
    return [name for name in cargo_manifests(root) if name.startswith(VENDOR_PREFIX)]


def vendor_packages(root: Path) -> set[str]:
    """Return the package names declared by the vendored manifests."""
    packages = set()
    for name in vendor_manifests(root):
        data = tomllib.loads((root / name).read_text(encoding="utf-8"))
        package = data.get("package", {}).get("name")
        if package:
            packages.add(package)
    return packages


def vendor_cache_enabled() -> bool:
    """Report whether the opt-in vendored Cargo dependency cache is active."""
    return os.environ.get("QA_VENDOR_CACHE", "").strip().lower() in {"1", "true"}


def vendor_mtime_epoch() -> int:
    """Return the epoch applied to vendored sources, defaulting on invalid input."""
    raw = os.environ.get("QA_VENDOR_MTIME_EPOCH", "").strip()
    if not raw:
        return DEFAULT_VENDOR_MTIME_EPOCH
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_VENDOR_MTIME_EPOCH


def _vendor_tree_files(root: Path) -> list[Path]:
    """Return regular files below the vendor root, sorted by repository path."""
    vendor = root / VENDOR_PREFIX.rstrip("/")
    if not vendor.is_dir():
        return []
    paths = []
    for directory, directories, names in os.walk(vendor):
        directories.sort()
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_file():
                paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def vendor_tree_digest(root: Path | None = None) -> str:
    """Return a stable digest of the vendored Cargo source tree.

    The committed git tree is the preferred identity: it ignores untracked build
    output and describes exactly the sources an archive was produced from.
    Content hashing keeps the digest usable in tests and in checkouts where git
    is unavailable or the directory is not a repository.
    """
    root = ROOT if root is None else root
    try:
        listing = subprocess.check_output(
            ["git", "-C", str(root), "ls-tree", "-r", "HEAD", "--", VENDOR_PREFIX.rstrip("/")],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        entries = [[path.relative_to(root).as_posix(), digest_file(path)]
                   for path in _vendor_tree_files(root)]
        return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()
    return hashlib.sha256(listing).hexdigest()


def cache_key(profile: str, runner: str, *, vendor_cache: bool | None = None,
              root: Path | None = None) -> str:
    """Return the branch archive key, adding vendored inputs only for the experiment."""
    enabled = vendor_cache_enabled() if vendor_cache is None else vendor_cache
    root = ROOT if root is None else root
    env = configured_environment()
    files = cargo_manifests(root) + [
        "src-tauri/Cargo.lock", ".cargo/config", ".cargo/config.toml",
        "src-tauri/.cargo/config", "src-tauri/.cargo/config.toml",
        "rust-toolchain", "rust-toolchain.toml", "src-tauri/rust-toolchain", "src-tauri/rust-toolchain.toml",
    ]
    inputs = {
        "manifests": fingerprint(root, files),
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
    if enabled:
        inputs["vendor"] = vendor_tree_digest(root)
        inputs["vendor_cache"] = True
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    return f"qa-cargo-dependencies-v1-{runner}-{profile}-{digest}"


def _unit_names(names: set[str]) -> set[str]:
    """Expand package and target names to their Cargo artifact spellings."""
    units = set(names)
    units |= {name.replace("-", "_") for name in units}
    return units | {f"lib{name}" for name in units}


def local_units(root: Path, *, include_vendor: bool = False) -> set[str]:
    """Return Cargo units that must stay out of the dependency archive.

    Vendored path dependencies are local while the vendor cache experiment is
    disabled. Enabling it drops them even when they are also workspace members,
    so Cargo can reuse their intermediates from the archive instead of
    rebuilding them on every warm build.
    """
    units: set[str] = set()
    for name in cargo_manifests(root):
        data = tomllib.loads((root / name).read_text(encoding="utf-8"))
        package = data.get("package", {}).get("name")
        if package:
            units.add(package)
        for target in [data.get("lib", {}), *data.get("bin", [])]:
            if "name" in target:
                units.add(target["name"])
    units = _unit_names(units)
    if include_vendor:
        units -= _unit_names(vendor_packages(root))
    return units


def _is_local_unit(filename: str, units: set[str]) -> bool:
    unit = re.split(r"-[a-f0-9]{16}(?:\b|_)", filename, maxsplit=1)[0]
    return unit in units


def _profile_dirs(profile_dir: Path) -> tuple[str, ...]:
    # Modern Cargo stores each unit's fingerprint and output together in
    # build/<package>/<hash>. Older versions have separate profile directories.
    if any(path.is_dir() and re.fullmatch(r"[a-f0-9]{16}", path.parent.name)
           for path in (profile_dir / "build").glob("*/*/fingerprint")):
        return ("build",)
    if all((profile_dir / directory).is_dir() for directory in PROFILE_DIRS):
        return PROFILE_DIRS
    raise ValueError(f"unrecognized Cargo build layout in {profile_dir}")


def _archive_member(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    return member if member.isfile() or member.isdir() or member.islnk() else None


def pack(destination: Path, profile: str, *, target: Path, cargo_home: Path, units: set[str]) -> None:
    directories = _profile_dirs(target / profile)
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / ARCHIVE_NAME
    with tarfile.open(archive, "w:gz", compresslevel=1) as stream:
        for directory in directories:
            base = target / profile / directory
            prefix = f"target/{profile}/{directory}"
            stream.add(base, prefix, recursive=False)
            for path in sorted(base.iterdir()):
                if not _is_local_unit(path.name, units):
                    stream.add(path, f"{prefix}/{path.name}", filter=_archive_member)
        if (target / SHERPA).is_dir():
            stream.add(target / SHERPA, f"target/{SHERPA}", filter=_archive_member)
        # Build scripts of *-sys crates can depend on the source mtimes. Cargo
        # can recreate the other unpacked registries from their .crate files.
        registry = cargo_home / "registry"
        locked = tomllib.loads(LOCK.read_text(encoding="utf-8"))["package"]
        packages = {f"{p['name']}-{p['version']}" for p in locked if p.get("source", "").startswith("registry+")}
        sys_packages = {f"{p['name']}-{p['version']}" for p in locked if p["name"].endswith("-sys")}
        for directory, names in (("cache", {f"{name}.crate" for name in packages}), ("src", sys_packages)):
            for path in sorted((registry / directory).glob("*/*")):
                if path.name in names:
                    stream.add(path, path.relative_to(cargo_home).as_posix(), filter=_archive_member)
    destination.joinpath("sha256").write_text(digest_file(archive) + "\n", encoding="ascii")


def _allowed_path(path: str, profile: str) -> bool:
    name = PurePosixPath(path)
    parts = name.parts
    if name.is_absolute() or ".." in parts or "\\" in path or ":" in path:
        return False
    return (parts[:2] == ("target", SHERPA)
            or parts[:2] == ("target", profile) and len(parts) >= 3 and parts[2] in PROFILE_DIRS
            or parts[:2] in (("registry", "cache"), ("registry", "src")) and len(parts) >= 4)


def _allowed(member: tarfile.TarInfo, profile: str) -> bool:
    return bool(_archive_member(member) and _allowed_path(member.name, profile)
                and (not member.islnk() or _allowed_path(member.linkname, profile)))


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
        _profile_dirs(staging / "target" / profile)
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


def normalize_vendor_mtimes(root: Path, epoch: int) -> int:
    """Pin the mtimes of vendored Cargo source files and return the file count.

    Cargo treats a path dependency as dirty when a source mtime is newer than
    the fingerprint restored from a cache archive. Only regular files change;
    the executable bit and every other mode bit survive, directories are left
    alone, and symlinks are never followed.
    """
    vendor = root / VENDOR_PREFIX.rstrip("/")
    if not vendor.is_dir():
        return 0
    normalized = 0
    for directory, directories, names in os.walk(vendor):
        directories[:] = sorted(name for name in directories
                                if not (Path(directory) / name).is_symlink())
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            os.utime(path, (epoch, epoch))
            normalized += 1
    return normalized


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("key", "pack", "restore", "normalize"))
    args = parser.parse_args(argv)
    if args.operation == "normalize":
        if not vendor_cache_enabled():
            print("qa-ui-auto: QA_VENDOR_CACHE is disabled; vendored Cargo mtimes were not changed")
            return
        count = normalize_vendor_mtimes(ROOT, vendor_mtime_epoch())
        print(f"qa-ui-auto: normalized mtimes of {count} vendored Cargo files")
        return
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
        pack(directory, profile, target=TARGET, cargo_home=cargo_home,
             units=local_units(ROOT, include_vendor=vendor_cache_enabled()))
    else:
        sherpa = restore(directory, profile, target=TARGET, cargo_home=cargo_home)
        with output.open("a", encoding="utf-8") as file:
            file.write(f"sherpa-hit={str(sherpa).lower()}\n")


if __name__ == "__main__":
    main()
