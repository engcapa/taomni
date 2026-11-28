"""Stage the pinned libraries beside the host for relocatable execution."""

import argparse
import os
from pathlib import Path
import re
import shutil

from runtime import (
    FFMPEG_ARCHIVE,
    HOST,
    LICENSE_DIR,
    MAX_PAYLOAD_BYTES,
    PLATFORMS,
    PORTS,
    SOURCE,
    output,
    prefix,
    run,
    runtime_files,
    runtime_libraries,
    verify_source,
    work_dir,
)

LINUX_SYSTEM_LIBRARIES = {
    "ld-linux-x86-64.so.2",
    "libc.so.6",
    "libdl.so.2",
    "libgcc_s.so.1",
    "libm.so.6",
    "libpthread.so.0",
    "librt.so.1",
    "libstdc++.so.6",
}
DARWIN_SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")


def relocate_linux(binary, libraries):
    needs = set(output("patchelf", "--print-needed", binary).splitlines())
    unknown = needs - libraries - LINUX_SYSTEM_LIBRARIES
    if unknown:
        raise ValueError(f"{binary.name} has unstaged dependencies {sorted(unknown)}")
    run("patchelf", "--set-rpath", "$ORIGIN", binary)


def macos_library_names(install_library_dir, library_names):
    library_dir = install_library_dir.resolve(strict=True)
    names = {}
    install_ids = {}
    for name in sorted(library_names):
        source = (library_dir / name).resolve(strict=True)
        if source.parent != library_dir or not source.is_file():
            raise ValueError(f"{name} resolves outside the pinned Media library directory")
        ids = output("otool", "-D", source).splitlines()[1:]
        if len(ids) != 1 or not ids[0].strip():
            raise ValueError(f"{source.name} does not have a single Mach-O install ID")
        install_id = ids[0].strip()
        install_ids[name] = install_id
        # The major-name link and the install ID can both name the file.
        family = re.escape(name.removesuffix(".dylib")) + r"(?:\.\d+)*\.dylib"
        for alias in (name, source.name, Path(install_id).name):
            if not re.fullmatch(family, alias) or names.get(alias, name) != name:
                raise ValueError(f"Unexpected install name {alias} for pinned Media library {name}")
            names[alias] = name
    return names, install_ids


def relocate_macos(binary, library_names, arch, install_id=None):
    if output("lipo", "-archs", binary).strip() != arch:
        raise ValueError(f"{binary.name} does not match the target architecture {arch}")
    deps = output("otool", "-L", binary).splitlines()[1:]
    arguments = []
    for line in deps:
        dep = line.strip().split(" (compatibility version ", 1)[0]
        if dep == install_id or dep.startswith(DARWIN_SYSTEM_PREFIXES):
            continue
        filename = library_names.get(Path(dep).name)
        if filename is None:
            raise ValueError(f"{binary.name} depends on an unstaged library {dep}")
        if dep != f"@loader_path/{filename}":
            arguments.extend(["-change", dep, f"@loader_path/{filename}"])
    if install_id is not None:
        target_id = f"@loader_path/{binary.name}"
        if install_id != target_id:
            arguments.extend(["-id", target_id])
    commands = output("otool", "-l", binary)
    for old in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)", commands):
        arguments.extend(["-delete_rpath", old])
    if arguments:
        run("install_name_tool", *arguments, binary)


def verify_payload(platform, payload):
    paths = [payload / name for name in runtime_files(platform)]
    for path in paths:
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            raise ValueError(f"Missing or invalid Media runtime file {path}")
    if (payload / LICENSE_DIR / SOURCE.name).read_bytes() != SOURCE.read_bytes():
        raise ValueError("Media source notice differs from the trusted recipe.")
    verify_source(payload / LICENSE_DIR / FFMPEG_ARCHIVE)
    total = sum(path.stat().st_size for path in payload.rglob("*") if path.is_file())
    if total > MAX_PAYLOAD_BYTES:
        raise ValueError("The TaOffice Media payload exceeds 100 MiB.")


def stage(platform, payload):
    install = prefix(platform)
    libraries = set(runtime_libraries(platform))
    windows = platform.startswith("windows-")
    host = payload / (HOST + (".exe" if windows else ""))
    if not host.is_file():
        raise ValueError(f"Stage the Media host before its runtime libraries. Missing {host}")
    darwin = platform.startswith("darwin-")
    if darwin:
        macos_names, install_ids = macos_library_names(install / "lib", libraries)
    for name in sorted(libraries):
        source = install / ("bin" if windows else "lib") / name
        target = payload / name
        shutil.copyfile(source, target)
        if not windows:
            target.chmod(0o755)

    if not windows:
        host.chmod(0o755)
        for binary in (host, *(payload / name for name in sorted(libraries))):
            if platform.startswith("linux-"):
                relocate_linux(binary, libraries)
            elif darwin:
                arch = "arm64" if platform == "darwin-aarch64" else "x86_64"
                relocate_macos(binary, macos_names, arch, install_ids.get(binary.name))

    license_root = payload / LICENSE_DIR
    license_root.mkdir(parents=True, exist_ok=True)
    for port in PORTS:
        shutil.copyfile(install / "share" / port / "copyright", license_root / f"{port}.txt")
    shutil.copyfile(SOURCE, license_root / SOURCE.name)
    source = work_dir() / "vcpkg" / "downloads" / FFMPEG_ARCHIVE
    shutil.copyfile(source, license_root / FFMPEG_ARCHIVE)
    verify_payload(platform, payload)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=PLATFORMS)
    parser.add_argument("payload", type=Path)
    arguments = parser.parse_args()
    stage(arguments.platform, arguments.payload)
