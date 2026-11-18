"""Fixed opaque business-data fixture and read-only uninstall oracle.

The fixture creates one file after trusted UI installation while invoke is
inactive. It never changes registry state, pointers, signatures, keys or code.
Only the application's Settings UI may retain or delete the file/locator.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .steps import StepError

DATA_NAME = "qa-retained.txt"
DATA_BYTES = b"Taomni module retained-data fixture\n\x00original bytes\n"


def ordinary(path: Path, *, directory=False):
    if path.resolve() != path or (not path.is_dir() if directory else not path.is_file()):
        raise StepError("Module data observation requires ordinary run-owned paths")


def assert_code_removed(owner: Path):
    ordinary(owner, directory=True)
    versions = owner / "versions"
    if versions.exists() or versions.is_symlink():
        raise StepError("Uninstall left executable versions or their signed proof on disk")


def observe(root: Path, phase: str, record: dict):
    owner = root / "hello-plugin"
    data = owner / "data"
    target = data / DATA_NAME
    control = root / ".retained-data"
    locator = control / "hello-plugin.json"
    ordinary(owner, directory=True)
    if phase == "seed-data":
        # This is explicit disposable input data, not a product mutation hook.
        # Refuse to overwrite an existing fixture or traverse a linked folder.
        data.mkdir(exist_ok=True)
        ordinary(data, directory=True)
        with target.open("xb") as stream:
            stream.write(DATA_BYTES)
        return {"fixture": str(target), "sha256": hashlib.sha256(DATA_BYTES).hexdigest()}
    if phase == "deleted":
        if data.exists() or data.is_symlink() or locator.exists() or locator.is_symlink():
            raise StepError("Explicit uninstall deletion left data or its locator behind")
        if record.get("dataRetained") is not False:
            raise StepError("Native registry incorrectly reports deleted data as retained")
        return {"dataAbsent": True, "locatorAbsent": True}
    ordinary(data, directory=True)
    ordinary(target)
    if target.read_bytes() != DATA_BYTES:
        raise StepError("Uninstall/reinstall changed retained business bytes")
    result = {"sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    if phase == "retained":
        ordinary(control, directory=True)
        ordinary(locator)
        expected = {"formatVersion": 1, "slug": "hello-plugin", "dataSchemaVersion": 1,
                    "files": [{"path": DATA_NAME, "kind": "file"}]}
        actual = json.loads(locator.read_text(encoding="utf-8"))
        if actual != expected:
            raise StepError(f"Core retained-data locator differs from actual data: {actual!r}")
        if record.get("dataRetained") is not True:
            raise StepError("Native registry lost the retained data directory")
        result["locator"] = actual
    return result
