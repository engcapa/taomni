"""Disposable snapshot data, an external OS lock, and an independent ZIP oracle.

Only the backup cancellation and mail category native cases use this helper.
It never launches the app or invokes product commands on behalf of a case.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
import zipfile
from contextlib import closing
from pathlib import Path
from typing import Any

from .backup_journal import read_journal

def seed_mail(data: Path) -> tuple[bytes, bytes]:
    account = "qa-backup-categories"
    stem = account + "-" + hashlib.sha256(account.encode()).hexdigest()[:16]
    raw = b"From: qa@example.com\r\nSubject: Backup original\r\n\r\nOriginal retained offline.\r\n"
    attachment = b"independent downloaded attachment"
    digest = hashlib.sha256(raw).hexdigest()
    payload = gzip.compress(raw)
    mail = data / "mail-cache"
    obj = mail / (stem + ".mail") / "objects" / digest[:2] / (digest + ".eml.gz")
    obj.parent.mkdir(parents=True, exist_ok=True)
    obj.write_bytes(payload)
    cached = mail / "attachments" / stem / "1" / "1.bin"
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(attachment)
    with closing(sqlite3.connect(mail / (stem + ".db"))) as db, db:
        db.execute("""CREATE TABLE mail_full_messages (
          account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
          uid_validity INTEGER NOT NULL, sha256 TEXT NOT NULL, raw_size INTEGER NOT NULL,
          stored_size INTEGER NOT NULL, stored_at INTEGER NOT NULL,
          header_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(account_id,folder,uid_validity,uid))""")
        db.execute("INSERT INTO mail_full_messages VALUES (?,?,?,?,?,?,?,?,?)", (account, "INBOX", 1, 1, digest, len(raw), len(payload), 1, '{"subject":"Backup original","hasAttachments":true}'))
    return raw, attachment


def inspect_selection(path: Path, work: Path, original: bytes, attachment: bytes) -> str:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        databases = [n for n in names if n.startswith("mail-cache/") and n.endswith(".db")]
        objects = [n for n in names if n.endswith(".eml.gz")]
        attachments = [n for n in names if n.endswith(".bin")]
        for name in objects:
            if gzip.decompress(archive.read(name)) != original:
                raise AssertionError("Original MIME bytes differ from fixture")
        for name in attachments:
            if archive.read(name) != attachment:
                raise AssertionError("Downloaded attachment bytes differ from fixture")
        rows = 0
        if databases:
            snapshot = work / (path.stem + ".db")
            snapshot.write_bytes(archive.read(databases[0]))
            with closing(sqlite3.connect(snapshot)) as db:
                rows = db.execute("SELECT count(*) FROM mail_full_messages").fetchone()[0]
                has_index = db.execute("SELECT count(*) FROM sqlite_master WHERE name='mail_archive_index'").fetchone()[0]
                index_rows = db.execute("SELECT count(*) FROM mail_archive_index").fetchone()[0] if has_index else rows
            if rows != len(objects) or index_rows != rows:
                raise AssertionError("Staged original/index rows reference missing objects")
        return f"mail_db={len(databases)},originals={len(objects)},attachments={len(attachments)},original_rows={rows}"


def setup(ctx: Any, root: Path, config: dict) -> None:
    data = root.parent
    config["selectedTargetIds"] = ["local"]
    (root / "config.json").write_text(json.dumps(config), encoding="utf-8")
    policy = {"autoBackupEnabled": False, "frequency": "daily", "maxRetainedCopies": 30,
              "defaultScope": "full", "includeMail": False, "lastBackupAt": None}
    (data / "backup_policy.json").write_text(json.dumps(policy), encoding="utf-8")
    work = Path(ctx.case_dir) / "snapshot-oracle"
    work.mkdir()
    command, events = work / "control.txt", work / "events.txt"
    command.write_text("idle", encoding="utf-8")
    events.write_text("", encoding="utf-8")
    ctx.values.update(backup_snapshot_control=str(command), backup_snapshot_events=str(events))
    original, attachment = seed_mail(data) if ctx.case_id == "TC-BACKUP-MAIL-001" else (b"", b"")
    if ctx.case_id == "TC-BACKUP-CANCEL-002":
        job_id = str(uuid.uuid4())
        recovery = {"id": job_id, "revision": 1, "targetId": config["targets"][0]["id"],
                    "operation": "upload", "phase": "preparing", "cancelRequested": True,
                    "bytes": 0, "total": None, "error": None, "artifact": None,
                    "remote": None, "receipt": None, "createdAt": int(time.time() * 1000)}
        journal = root / "jobs" / (job_id + ".json")
        journal.parent.mkdir(exist_ok=True)
        journal.write_text(json.dumps(recovery), encoding="utf-8")
        ctx.values.update(backup_recovered_id=job_id, backup_recovered_journal=str(journal))
    stop = threading.Event()

    def event(value: str) -> None:
        with events.open("a", encoding="utf-8") as out:
            out.write(value + "\n")

    def observe() -> None:
        lock_file = None
        seen, stopped = set(), set()
        try:
            while not stop.wait(0.02):
                control = command.read_text(encoding="utf-8").strip()
                if control.startswith("hold") and lock_file is None:
                    lock_file = (data / ".backup-operation.lock").open("a+b")
                    if os.name == "nt":
                        import msvcrt
                        if lock_file.tell() == 0:
                            lock_file.write(b"0")
                            lock_file.flush()
                        lock_file.seek(0)
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    event(control + "=locked")
                if control.startswith("release") and lock_file is not None:
                    lock_file.close()
                    lock_file = None
                    event(control + "=released")
                for journal in (root / "jobs").glob("*.json"):
                    job = read_journal(journal)
                    if job.get("phase") == "cancelled" and job["id"] not in stopped:
                        stopped.add(job["id"])
                        artifact = root / "artifacts" / job["id"] / "archive.taobak"
                        operation = "recovered" if job["id"] == ctx.values.get("backup_recovered_id") else job["operation"]
                        event(f"cancelled:{operation}:requested={str(job.get('cancelRequested', False)).lower()}:artifact={str(artifact.exists() or bool(job.get('localPath'))).lower()}")
                    path = job.get("localPath")
                    if job.get("phase") == "completed" and path and job["id"] not in seen:
                        seen.add(job["id"])
                        if original:
                            event(inspect_selection(Path(path), work, original, attachment))
                        else:
                            with zipfile.ZipFile(path) as archive:
                                if "manifest.json" not in archive.namelist():
                                    raise AssertionError("Local backup did not publish a valid archive")
                            event("local_completed:valid_archive=true")
        except Exception as error:
            event(f"ORACLE_ERROR:{type(error).__name__}:{error} "
                  f"[errno={getattr(error, 'errno', None)},winerror={getattr(error, 'winerror', None)}]")
        finally:
            if lock_file is not None:
                lock_file.close()

    thread = threading.Thread(target=observe, daemon=True)
    ctx._backup_snapshot_observer = stop, thread
    thread.start()


def teardown(ctx: Any) -> None:
    observer = getattr(ctx, "_backup_snapshot_observer", None)
    if observer:
        observer[0].set()
        observer[1].join(timeout=5)
