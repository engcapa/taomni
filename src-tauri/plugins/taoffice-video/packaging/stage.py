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


def relocate_macos(binary, library_names, arch):
    if output("lipo", "-archs", binary).strip() != arch:
        raise ValueError(f"{binary.name} does not match the target architecture {arch}")
    deps = output("otool", "-L", binary).splitlines()[1:]
    arguments = []
    for line in deps:
        dep = line.strip().split(" (compatibility version ", 1)[0]
        if dep.startswith(DARWIN_SYSTEM_PREFIXES):
            continue
        filename = Path(dep).name
        if filename not in library_names:
            raise ValueError(f"{binary.name} depends on an unstaged library {dep}")
        if dep != f"@loader_path/{filename}":
            arguments.extend(["-change", dep, f"@loader_path/{filename}"])
    if binary.suffix == ".dylib":
        arguments.extend(["-id", f"@loader_path/{binary.name}"])
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
            else:
                arch = "arm64" if platform == "darwin-aarch64" else "x86_64"
                relocate_macos(binary, libraries, arch)

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
