"""Read-only retained-data proof for the real hello SQLite restore scenario.

The fixed text-file uninstall scenario has a different dataset. This observer
uses the original verified SQLite archive and never creates or repairs data.
"""
import hashlib
import json
import zipfile

from .module_retained_observation import ordinary
from .steps import StepError


def check_retained_sqlite(root, archive, archive_sha256, record):
    if record.get("state") != "uninstalled" or record.get("dataRetained") is not True:
        raise StepError("Restored native registry lost the uninstalled retained data")
    owner = root / "hello-plugin"
    data = owner / "data"
    target = data / "hello.sqlite"
    control = root / ".retained-data"
    locator = control / "hello-plugin.json"
    for directory in (owner, data, control):
        ordinary(directory, directory=True)
    ordinary(target)
    ordinary(locator)
    expected = {"formatVersion": 1, "slug": "hello-plugin", "dataSchemaVersion": 1,
                "files": [{"path": "hello.sqlite", "kind": "sqlite"}]}
    if json.loads(locator.read_text(encoding="utf-8")) != expected:
        raise StepError("Restored retained-data locator differs from the original SQLite dataset")
    ordinary(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != archive_sha256:
        raise StepError("Original verified archive changed after automatic restore")
    with zipfile.ZipFile(archive) as zipped:
        original = zipped.read("plugins/hello-plugin/data/hello.sqlite")
    payload = target.read_bytes()
    if payload != original:
        raise StepError("Restored retained SQLite bytes differ from the original verified snapshot")
    return {"locator": expected, "dataRetained": True, "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest()}
