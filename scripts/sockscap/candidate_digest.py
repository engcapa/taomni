#!/usr/bin/env python3
"""Stable content digest for a signed macOS application bundle."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import struct
from typing import Any


BUNDLE_DIGEST_ALGORITHM = "taomni-directory-tree-sha256-v1"


class CandidateDigestError(RuntimeError):
    pass


def _frame(digest: Any, value: bytes) -> None:
    digest.update(struct.pack(">Q", len(value)))
    digest.update(value)


def directory_tree_sha256(root: Path) -> str:
    """Hash bundle paths, types, modes, xattrs, symlink targets, and file bytes."""

    root = root.resolve(strict=True)
    if not root.is_dir():
        raise CandidateDigestError(f"candidate bundle is not a directory: {root}")

    def raise_walk_error(error: OSError) -> None:
        raise CandidateDigestError(f"cannot enumerate candidate bundle: {error}")

    entries: list[tuple[bytes, Path]] = [(b"", root)]
    for current, directory_names, file_names in os.walk(
        root, followlinks=False, onerror=raise_walk_error
    ):
        directory_names.sort(key=os.fsencode)
        file_names.sort(key=os.fsencode)
        current_path = Path(current)
        for name in (*directory_names, *file_names):
            path = current_path / name
            relative_bytes = os.fsencode(path.relative_to(root))
            entries.append((relative_bytes, path))
    entries.sort(key=lambda item: item[0])

    digest = hashlib.sha256()
    digest.update(BUNDLE_DIGEST_ALGORITHM.encode("ascii") + b"\0")
    for relative_bytes, path in entries:
        metadata = path.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISREG(metadata.st_mode):
            kind = b"F"
        elif stat.S_ISDIR(metadata.st_mode):
            kind = b"D"
        elif stat.S_ISLNK(metadata.st_mode):
            kind = b"L"
        else:
            raise CandidateDigestError(
                f"unsupported special file in candidate bundle: {path}"
            )

        digest.update(kind)
        digest.update(struct.pack(">I", mode))
        _frame(digest, relative_bytes)
        try:
            extended_attribute_names = sorted(
                os.listxattr(path, follow_symlinks=False), key=os.fsencode
            )
        except OSError as error:
            raise CandidateDigestError(
                f"cannot enumerate extended attributes for {path}: {error}"
            ) from error
        digest.update(struct.pack(">Q", len(extended_attribute_names)))
        for name in extended_attribute_names:
            try:
                value = os.getxattr(path, name, follow_symlinks=False)
            except OSError as error:
                raise CandidateDigestError(
                    f"cannot read extended attribute {name!r} for {path}: {error}"
                ) from error
            _frame(digest, os.fsencode(name))
            _frame(digest, value)
        if kind == b"F":
            digest.update(struct.pack(">Q", metadata.st_size))
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif kind == b"L":
            _frame(digest, os.fsencode(os.readlink(path)))
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    try:
        print(directory_tree_sha256(args.bundle))
    except (CandidateDigestError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
