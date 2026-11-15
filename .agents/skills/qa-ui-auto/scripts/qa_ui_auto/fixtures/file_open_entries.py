"""Persisted AI conversation, real Git worktree and POSIX SFTP inputs, no UI/store hooks."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

from . import file_open_files, parity008_git
from .backup_policy import isolated_data_root

THREAD_ID = "qa-file-open-entry-thread"


def setup(ctx):
    file_open_files.setup(ctx)
    parity008_git.setup(ctx)
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    local = ctx.values["parity008_root"] + "/repo-b/same.txt"
    now = int(time.time())
    thread = {"id": THREAD_ID, "title": "QA file path entry", "provider_id": "deepseek", "created_at": now,
              "updated_at": now, "linked_session_id": "welcome", "source": "drawer", "mode": "chat", "output_format": "md"}
    message = {"id": "qa-file-open-message", "thread_id": THREAD_ID, "role": "assistant",
               "content": "Generated local file: `" + local + "`. Open it without sending a terminal command.",
               "created_at": now, "redacted": False}
    ctx.values.update(file_open_entry_path=local, file_open_entry_thread=THREAD_ID,
                      file_open_entry_thread_title=thread["title"])
    if native:
        with closing(sqlite3.connect(isolated_data_root(ctx) / "taomni.db")) as db, db:
            db.executescript("""CREATE TABLE IF NOT EXISTS ai_chat_threads (id TEXT PRIMARY KEY,title TEXT NOT NULL,provider_id TEXT NOT NULL DEFAULT 'deepseek',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,linked_session_id TEXT,source TEXT NOT NULL DEFAULT 'drawer');
            CREATE TABLE IF NOT EXISTS ai_chat_messages (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL,redacted INTEGER NOT NULL DEFAULT 0);""")
            db.execute("INSERT INTO ai_chat_threads(id,title,provider_id,created_at,updated_at,linked_session_id,source) VALUES(?,?,?,?,?,?,?)", tuple(thread[key] for key in ["id", "title", "provider_id", "created_at", "updated_at", "linked_session_id", "source"]))
            db.execute("INSERT INTO ai_chat_messages(id,thread_id,role,content,created_at,redacted) VALUES(?,?,?,?,?,?)", tuple(message[key] for key in ["id", "thread_id", "role", "content", "created_at", "redacted"]))
    else:
        ctx.page.evaluate("([thread,message]) => { localStorage.setItem('taomni.stub.chatThreads.v1',JSON.stringify([thread])); localStorage.setItem('taomni.stub.chatMessages.v1',JSON.stringify({[thread.id]:[message]})); }", [thread, message])
    # Fixture uses the explicitly configured service only. The case still creates
    # its SSH session/authenticates through real production controls.
    config = ctx.cfg.get("ssh_posix") or {}
    password = ctx.env.get("QA_POSIX_SSH_PASSWORD") or os.environ.get("QA_POSIX_SSH_PASSWORD") or config.get("password")
    if not config.get("host") or not password:
        raise RuntimeError("file_open_entries requires the explicit POSIX SSH fixture")
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(str(config["host"]), port=int(config["port"]), username=str(config["user"]), password=password,
                   allow_agent=False, look_for_keys=False, timeout=15)
    remote = "/tmp/taomni-file-open-" + uuid4().hex[:12]
    ctx.values["file_open_entry_remote"] = remote
    ctx._file_open_remote_client = client
    with client.open_sftp() as sftp:
        sftp.mkdir(remote)
        with sftp.file(remote + "/remote.txt", "wb") as stream:
            stream.write(b"SFTP read-only entry bytes.\n")
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    (ctx.case_dir / "file-open-entry-fixture.json").write_text(json.dumps({"local": local, "remote": remote,
        "thread": thread, "message": message, "mode": "native" if native else "browser",
        "boundary": "Persisted input conversation and known worktree; no provider generation claimed. Real SSH/SFTP bytes; browser local files remain VFS."}, indent=2), encoding="utf-8")


def teardown(ctx):
    client = getattr(ctx, "_file_open_remote_client", None)
    if client:
        try:
            with client.open_sftp() as sftp:
                root = ctx.values["file_open_entry_remote"]
                sftp.remove(root + "/remote.txt")
                sftp.rmdir(root)
        finally:
            client.close()
    parity008_git.teardown(ctx)
