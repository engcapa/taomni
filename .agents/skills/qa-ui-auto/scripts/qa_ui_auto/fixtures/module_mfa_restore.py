"""Build a staged modular restore from the actual legacy desktop's encrypted stores."""
from contextlib import closing
import hashlib
import json
import sqlite3
import time
import uuid


CASE_ID = "TC-MODULES-048"
MODULE_DB = "plugins/mfa/data/mfa.db"
SIGNED_BACKUP_STATES = {
    "TC-MODULES-104": "enabled",
    "TC-MODULES-105": "disabled",
    "TC-MODULES-106": "uninstalled",
}


def stage(profile, source, evidence):
    entries = []
    for name, relative in (("vault.db", "databases/vault.db"), ("mfa.db", MODULE_DB)):
        original = source / name
        if original.is_symlink() or not original.is_file():
            raise RuntimeError(f"Legacy desktop did not create {name}")
        target = profile / ".pending_restore" / relative
        target.parent.mkdir(parents=True)
        with closing(sqlite3.connect(original.as_uri() + "?mode=ro", uri=True)) as database:
            with closing(sqlite3.connect(target)) as snapshot:
                database.backup(snapshot)
        entries.append({
            "path": relative, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "sizeBytes": target.stat().st_size,
        })
    now = int(time.time() * 1000)
    intent = {"staged_at": now, "manifest": {
        "formatVersion": 2, "appName": "Taomni", "appVersion": "0.5.10", "createdAt": now,
        "backupScope": "core", "encrypted": False, "files": entries,
        "pluginDatasets": [{
            "slug": "mfa", "dataSchemaVersion": 1, "requiresVault": True,
            "job": str(uuid.uuid4()), "profileGeneration": str(uuid.uuid4()),
            "files": [{"path": "mfa.db", "kind": "sqlite"}],
        }],
    }}
    encoded = json.dumps(intent, indent=2) + "\n"
    (profile / "restore_intent.json").write_text(encoded, encoding="utf-8")
    (evidence / "modular-restore-input.json").write_text(encoded, encoding="utf-8")
    return entries[1]["sha256"]
