"""Compile, stage, and verify the Linux SocksCap ptrace launcher in the module package."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess

RESOURCE = Path("resources/linux")
LAUNCHER = "taomni-sockscap-trace-launcher"
SOURCE_NAME = "trace_launcher.c"
ELF_MAGIC = b"\x7fELF"
CFLAGS = (
    "-fPIE",
    "-pie",
    "-O2",
    "-fvisibility=hidden",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wl,-z,relro",
    "-Wl,-z,now",
    "-Wl,-z,noexecstack",
)


def files(slug: str, platform: str) -> tuple[str, ...]:
    if slug == "sockscap" and platform == "linux-x86_64":
        return ((RESOURCE / LAUNCHER).as_posix(),)
    return ()


def build(source: Path, output: Path) -> None:
    c_source = source / RESOURCE / SOURCE_NAME
    if c_source.is_symlink() or not c_source.is_file():
        raise ValueError(f"Missing Linux SocksCap trace launcher source: {c_source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    compiler = os.environ.get("CC", "cc")
    subprocess.run([compiler, *CFLAGS, str(c_source), "-o", str(output)], check=True)
    os.chmod(output, 0o755)
    head = output.read_bytes()[:4]
    if head != ELF_MAGIC or output.stat().st_size == 0:
        raise ValueError(f"Built Linux SocksCap trace launcher is not a valid ELF binary: {output}")


def verify(slug: str, platform: str, payload: Path) -> None:
    expected = files(slug, platform)
    directory = payload / RESOURCE
    if not expected:
        if directory.exists() or directory.is_symlink():
            raise ValueError("Unexpected Linux SocksCap capture resource for this module target")
        return
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Missing Linux SocksCap capture resource directory")
    if {entry.name for entry in directory.iterdir()} != {LAUNCHER}:
        raise ValueError("Unexpected or missing Linux SocksCap capture payload")
    launcher = directory / LAUNCHER
    if launcher.is_symlink() or not launcher.is_file() or launcher.stat().st_size == 0:
        raise ValueError("Linux SocksCap trace launcher is missing or invalid")
    with launcher.open("rb") as stream:
        if stream.read(4) != ELF_MAGIC:
            raise ValueError("Linux SocksCap trace launcher is not an ELF executable")


def stage(slug: str, platform: str, source: Path, payload: Path) -> None:
    if not files(slug, platform):
        return
    build(source, payload / RESOURCE / LAUNCHER)
    verify(slug, platform, payload)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("source", type=Path)
    stage_parser.add_argument("payload", type=Path)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("slug")
    verify_parser.add_argument("platform")
    verify_parser.add_argument("payload", type=Path)
    args = parser.parse_args()
    if args.command == "stage":
        stage("sockscap", "linux-x86_64", args.source, args.payload)
    else:
        verify(args.slug, args.platform, args.payload)
