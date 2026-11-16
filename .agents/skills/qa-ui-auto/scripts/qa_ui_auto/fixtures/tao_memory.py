"""Nonempty approved entries, seeded before startup in the owned native profile.

All edits, deletes and exports in TC-TAO-HOME-034 then use real native IPC.
"""
from contextlib import closing
from pathlib import Path
import sqlite3

from .backup_policy import isolated_data_root


def setup(ctx):
    data = isolated_data_root(ctx)
    with closing(sqlite3.connect(data / "taomni.db")) as db, db:
        db.execute("""CREATE TABLE tao_memory_entries (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
            content TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)""")
        db.executemany("INSERT INTO tao_memory_entries VALUES(?,?,?,?,?,?)", [
            ("qa-memory", "memory", "QA saved preference", "Original saved preference", 1, 1),
            ("qa-skill", "skill", "/qa-review", "Original saved review skill", 1, 1),
            ("qa-soul", "soul", "QA identity", "Preserve this approved identity", 1, 1),
        ])
    ctx.values["tao_memory_export"] = str((Path(ctx.case_dir) / "approved-memory.json").resolve())
