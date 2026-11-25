"""Stage a synthetic v1 restore under the owned old-profile fixture."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import time

CASE_ID = "TC-MODULES-047"
PHASE = "legacy-restore-applied"
ARCHIVE_PATH = "databases/taomni.db"
LIVE_NAME = "Live before the legacy restore"


def stage(ctx, profile, session):
    source = profile / "taomni.db"
    pending = profile / ".pending_restore" / ARCHIVE_PATH
    pending.parent.mkdir(parents=True)
    shutil.copyfile(source, pending)
    contents = pending.read_bytes()
    staged_at = int(time.time() * 1000)
    intent = {
        "staged_at": staged_at,
        "manifest": {
            "formatVersion": 1, "appName": "Taomni", "appVersion": "0.5.10",
            "createdAt": staged_at, "backupScope": "core", "encrypted": False,
            "files": [{"path": ARCHIVE_PATH, "sha256": hashlib.sha256(contents).hexdigest(),
                       "sizeBytes": len(contents)}],
        },
    }
    (profile / "restore_intent.json").write_text(json.dumps(intent), encoding="utf-8")
    with closing(sqlite3.connect(source)) as connection, connection:
        result = connection.execute("UPDATE sessions SET name = ? WHERE id = ?", (LIVE_NAME, session["id"]))
        if result.rowcount != 1:
            raise RuntimeError("Legacy restore fixture must diverge from its staged backup")
    (Path(ctx.case_dir) / "legacy-restore-input.json").write_text(json.dumps({
        "intent": intent, "session": {"id": session["id"], "name": session["name"]},
        "liveName": LIVE_NAME,
    }, indent=2) + "\n", encoding="utf-8")


def observe(profile, session):
    for name in ("restore_intent.json", "restore_journal.json", ".pending_restore"):
        path = profile / name
        if path.is_symlink() or path.exists():
            raise RuntimeError(f"Legacy restore did not clear {name}")
    database = profile / "taomni.db"
    if database.is_symlink() or not database.is_file():
        raise RuntimeError("The restored session database must be a regular file")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        observed = connection.execute("SELECT name FROM sessions WHERE id = ?", (session["id"],)).fetchone()
    if observed != (session["name"],):
        raise RuntimeError("The staged backup did not restore the original session name")
    return {"sessionId": session["id"], "restoredName": observed[0]}
