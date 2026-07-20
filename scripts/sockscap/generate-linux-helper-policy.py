#!/usr/bin/env python3
"""Generate the installed Linux Sockscap helper policy from final binaries."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from typing import Any


POLICY_SCHEMA_VERSION = 1
PRODUCT_ID = "com.taomni.app"
CHUNK_BYTES = 1024 * 1024


class LinuxPolicyError(RuntimeError):
    pass


def sha256_stable_regular_file(path: Path) -> str:
    """Hash one non-empty regular file through a no-follow descriptor."""

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise LinuxPolicyError(f"cannot open release binary {path}: {error}") from error

    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
            raise LinuxPolicyError(
                f"release binary must be a non-empty regular file: {path}"
            )
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(CHUNK_BYTES), b""):
                digest.update(chunk)
        after = os.fstat(descriptor)
        identity_before = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        identity_after = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if identity_before != identity_after:
            raise LinuxPolicyError(f"release binary changed while hashing: {path}")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def build_policy(
    application: Path, helper: Path, runtimes: list[Path] | None = None
) -> dict[str, Any]:
    application_sha256 = sha256_stable_regular_file(application)
    helper_sha256 = sha256_stable_regular_file(helper)
    runtime_paths = runtimes or [application]
    runtime_sha256 = sorted(
        {sha256_stable_regular_file(runtime) for runtime in runtime_paths}
    )
    return {
        "schemaVersion": POLICY_SCHEMA_VERSION,
        "productId": PRODUCT_ID,
        "allowedCallerSha256": [application_sha256],
        "allowedHelperSha256": [helper_sha256],
        "allowedRuntimeSha256": runtime_sha256,
    }


def write_policy_atomic(path: Path, policy: dict[str, Any]) -> None:
    """Publish one deterministic policy without following an output symlink."""

    parent = path.parent.resolve(strict=True)
    destination = parent / path.name
    try:
        metadata = destination.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is not None and not stat.S_ISREG(metadata.st_mode):
        raise LinuxPolicyError(
            f"refusing to replace a non-regular policy destination: {destination}"
        )

    encoded = (
        json.dumps(policy, indent=2, sort_keys=True, separators=(",", ": ")) + "\n"
    ).encode("utf-8")
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{path.name}.", dir=parent, delete=False
        ) as temporary:
            temporary_name = temporary.name
            os.fchmod(temporary.fileno(), 0o644)
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
        directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as error:
        raise LinuxPolicyError(f"cannot publish helper policy {destination}: {error}") from error
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application", required=True, type=Path)
    parser.add_argument("--helper", required=True, type=Path)
    parser.add_argument(
        "--runtime",
        action="append",
        default=[],
        type=Path,
        help="approved data-runtime binary; defaults to the application binary",
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        policy = build_policy(args.application, args.helper, args.runtime or None)
        write_policy_atomic(args.output, policy)
    except (LinuxPolicyError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
