"""Build the pinned shared LGPL FFmpeg libraries using the selected SDK."""

import argparse
import os
from pathlib import Path
import platform as system
import subprocess

from runtime import (
    FFMPEG_ARCHIVE,
    FFMPEG_FEATURES,
    PLATFORMS,
    VCPKG_REPOSITORY,
    VCPKG_REVISION,
    output,
    prefix,
    run,
    triplet,
    verify_source,
    work_dir,
)


def target_triplet(target):
    cpu, os_name = PLATFORMS[target].split("-")
    lines = [
        f"set(VCPKG_TARGET_ARCHITECTURE {cpu})",
        "set(VCPKG_CRT_LINKAGE dynamic)",
        "set(VCPKG_BUILD_TYPE release)",
        'if(PORT STREQUAL "ffmpeg")',
        "  set(VCPKG_LIBRARY_LINKAGE dynamic)",
        "else()",
        "  set(VCPKG_LIBRARY_LINKAGE static)",
        "endif()",
    ]
    if os_name == "linux":
        lines.append("set(VCPKG_CMAKE_SYSTEM_NAME Linux)")
        lines.extend(["set(VCPKG_C_FLAGS -fPIC)", "set(VCPKG_CXX_FLAGS -fPIC)"])
    if os_name == "osx":
        arch = "arm64" if cpu == "arm64" else "x86_64"
        lines.extend([
            "set(VCPKG_CMAKE_SYSTEM_NAME Darwin)",
            f"set(VCPKG_OSX_ARCHITECTURES {arch})",
            "set(VCPKG_OSX_DEPLOYMENT_TARGET 11.0)",
            'set(VCPKG_LINKER_FLAGS "-Wl,-headerpad_max_install_names")',
        ])
    return "\n".join(lines) + "\n"


def checkout(root):
    if not (root / ".git").exists():
        run("git", "init", root)
    revision = subprocess.run(
        ["git", "-C", root, "rev-parse", "--verify", "--quiet", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
    if revision != VCPKG_REVISION:
        run("git", "-C", root, "fetch", "--depth=1", VCPKG_REPOSITORY, VCPKG_REVISION)
        run("git", "-C", root, "checkout", "--detach", "FETCH_HEAD")
    if output("git", "-C", root, "rev-parse", "HEAD").strip() != VCPKG_REVISION:
        raise ValueError("The vcpkg checkout does not match the pinned revision.")


def prepare(target):
    work = work_dir()
    root = work / "vcpkg"
    if " " in str(work):
        raise ValueError("Set TAOFFICE_MEDIA_BUILD_DIR to a path without spaces for the FFmpeg build.")
    work.mkdir(parents=True, exist_ok=True)
    checkout(root)
    windows = target.startswith("windows-")
    executable = root / ("vcpkg.exe" if windows else "vcpkg")
    if not executable.is_file():
        bootstrap = ["cmd", "/c", "bootstrap-vcpkg.bat"] if windows else ["bash", "./bootstrap-vcpkg.sh"]
        run(*bootstrap, "-disableMetrics", cwd=root)

    triplets = work / "triplets"
    triplets.mkdir(exist_ok=True)
    (triplets / f"{triplet(target)}.cmake").write_text(target_triplet(target), encoding="utf-8")
    host_platform = PLATFORMS[target]
    if target.startswith("darwin-"):
        host_platform = "arm64-osx" if system.machine() == "arm64" else "x64-osx"
    run(
        executable, "install", f"ffmpeg[core,{FFMPEG_FEATURES}]",
        "--classic", f"--triplet={triplet(target)}", f"--host-triplet={host_platform}",
        f"--overlay-triplets={triplets}", f"--x-install-root={work / 'installed'}",
        "--binarysource=clear", "--clean-buildtrees-after-build", "--clean-packages-after-build", cwd=root,
    )
    verify_source(root / "downloads" / FFMPEG_ARCHIVE)
    install = prefix(target)
    if github_env := os.environ.get("GITHUB_ENV"):
        with Path(github_env).open("a", encoding="utf-8") as stream:
            stream.write(f"FFMPEG_DIR={install}\n")
            if windows:
                llvm = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "LLVM" / "bin"
                if (llvm / "libclang.dll").is_file():
                    stream.write(f"LIBCLANG_PATH={llvm}\n")
    print(f"FFMPEG_DIR={install}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=PLATFORMS)
    prepare(parser.parse_args().platform)
