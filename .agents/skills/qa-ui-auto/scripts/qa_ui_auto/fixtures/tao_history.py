"""Synthetic Home and legacy transcripts in the verified QA profile only.

The product initializes/migrates the remaining schema on launch. Deletion and
reload then go through the real UI, Tauri IPC and original stores.
"""
from contextlib import closing
import json
import sqlite3

from .backup_policy import isolated_data_root


def setup(ctx):
    data = isolated_data_root(ctx)
    with closing(sqlite3.connect(data / "taomni.db")) as db, db:
        db.executescript("""
            CREATE TABLE ai_chat_threads (
                id TEXT PRIMARY KEY, title TEXT NOT NULL,
                provider_id TEXT NOT NULL DEFAULT 'deepseek',
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                linked_session_id TEXT, source TEXT NOT NULL DEFAULT 'drawer');
            CREATE TABLE ai_chat_messages (
                id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, created_at INTEGER NOT NULL,
                redacted INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(thread_id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE);
            CREATE TABLE ds_app_threads (
                id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL,
                last_request TEXT,
                FOREIGN KEY(id) REFERENCES ai_chat_threads(id) ON DELETE CASCADE);
        """)
        for thread_id, title, text, updated in [
            ("qa-home-delete", "QA Home delete", "Delete this Home transcript", 30000),
            ("qa-home-keep", "QA Home keep", "Retain this Home transcript", 20000),
        ]:
            snapshot = dict(id=thread_id, title=title, source="tao", updatedAt=updated,
                            messages=[dict(id=thread_id + "-message", role="assistant", text=text,
                                           blocks=[dict(id=thread_id + "-text", type="text", text=text)],
                                           createdAt=updated)])
            db.execute("INSERT INTO ai_chat_threads VALUES(?,?,?,0,?,NULL,'home')",
                       (thread_id, title, "deepseek-app", updated // 1000))
            db.execute("INSERT INTO ds_app_threads VALUES(?,?,?,NULL)",
                       (thread_id, json.dumps(snapshot), updated))
        db.execute("INSERT INTO ai_chat_threads VALUES('qa-legacy-delete','QA legacy delete','deepseek',0,10,NULL,'drawer')")
        db.execute("INSERT INTO ai_chat_messages VALUES('qa-legacy-message','qa-legacy-delete','assistant','Delete this legacy transcript',10,0)")
