"""Read-only independent SQLite/gzip/ZIP validation for native mail cases."""
from __future__ import annotations
import email
from contextlib import closing
import gzip
import hashlib
import json
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Any


def observe(root: Path, expected: dict, full: dict, headers: dict) -> dict:
    dbs = list(root.glob("*.db"))
    if len(dbs) != 1:
        raise AssertionError(f"Expected one mailbox DB in {root}, got {len(dbs)}")
    with closing(sqlite3.connect(dbs[0].as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT folder,uid,sha256,raw_size FROM mail_full_messages").fetchall()
        summary = dict(db.execute("SELECT folder,count(*) FROM mail_messages GROUP BY folder"))
    actual = {}
    for folder, uid, digest, size in rows:
        actual[folder] = actual.get(folder, 0) + 1
        path = root / f"{dbs[0].stem}.mail" / "objects" / digest[:2] / f"{digest}.eml.gz"
        raw = gzip.decompress(path.read_bytes())
        assert hashlib.sha256(raw).hexdigest() == digest and len(raw) == size, "Stored MIME integrity failed"
        oracle = expected[f"{folder}/{uid}"]
        assert digest == oracle["sha256"] and size == oracle["rawSize"], "Full MIME differs from fixture original"
        parsed = email.message_from_bytes(raw)
        attachments = [part.get_payload(decode=True) for part in parsed.walk() if part.get_filename()]
        assert any(hashlib.sha256(data).hexdigest() == oracle["attachmentSha256"] for data in attachments), "Attachment bytes missing"
    assert actual == {k: v for k, v in full.items() if v}, f"Full objects: {actual}, expected {full}"
    for folder, count in headers.items():
        assert summary.get(folder, 0) == count, f"Summary count {folder}: {summary}"
    objects = list(root.glob("*.mail/objects/*/*.eml.gz"))
    assert len(objects) == len({row[2] for row in rows}), "Unreferenced objects remain after explicit cleanup"
    return {"full": actual, "headers": summary, "objects": len(objects)}


def observe_incremental(root: Path, expected: dict) -> dict:
    dbs = list(root.glob("*.db"))
    assert len(dbs) == 1, "Expected one mailbox DB"
    with closing(sqlite3.connect(dbs[0].as_uri() + "?mode=ro", uri=True)) as db:
        synced = db.execute("SELECT COUNT(*) FROM mail_messages WHERE folder='INBOX'").fetchone()[0]
        folder = db.execute("SELECT total,sync_complete FROM mail_folders WHERE name='INBOX'").fetchone()
        assert folder is not None, "INBOX has not been indexed yet"
        total, complete = folder
        rows = db.execute("SELECT uid,sha256,raw_size FROM mail_full_messages WHERE folder='INBOX'").fetchall()
    assert total == 350 and 0 < synced < total and not complete, f"History must still be incomplete: {synced}/{total}, complete={complete}"
    assert 0 < len(rows) <= synced, "No complete originals before history completes"
    for uid, digest, size in rows:
        raw = gzip.decompress((root / f"{dbs[0].stem}.mail" / "objects" / digest[:2] / f"{digest}.eml.gz").read_bytes())
        assert hashlib.sha256(raw).hexdigest() == digest == expected[f"INBOX/{uid}"]["sha256"], "Early original integrity failed"
        assert len(raw) == size == expected[f"INBOX/{uid}"]["rawSize"], "Early original truncated"
    return {"headers": synced, "server_total": total, "sync_complete": complete, "full": len(rows), "verified_originals": len(rows)}


def check(ctx: Any, args: dict) -> str:
    root = Path(args["root"]).resolve()
    report = ctx.case_dir.parent.resolve()
    expected_path = Path(args["expected"]).resolve()
    if not root.is_relative_to(report) or not expected_path.is_relative_to(report):
        raise ValueError("mail_storage_assert refuses paths outside the retained QA report")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    deadline = time.monotonic() + float(args.get("timeout_sec", 30))
    last = None
    while time.monotonic() < deadline:
        try:
            if args.get("kind") == "incremental":
                result = observe_incremental(root, expected)
            elif args.get("kind", "storage") == "backup":
                archives = sorted(root.glob("*.taobak"), key=lambda p: p.stat().st_mtime_ns)
                assert archives, "No backup archive"
                with zipfile.ZipFile(archives[-1]) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    paths = [entry["path"] for entry in manifest["files"]]
                    mail = [path for path in paths if path.startswith("mail-cache/")]
                    assert bool(mail) == args["include_mail"], f"Unexpected mail backup selection: {mail}"
                    objects = [path for path in mail if path.endswith(".eml.gz")]
                    assert len(objects) == args.get("objects", 0), f"Backup object count {len(objects)}"
                    for name in objects:
                        digest = hashlib.sha256(gzip.decompress(archive.read(name))).hexdigest()
                        assert any(value["sha256"] == digest for value in expected.values()), "Backup contains incorrect MIME"
                        assert archive.getinfo(name).compress_type == zipfile.ZIP_STORED, "Compressed MIME was recompressed"
                result = {"archive": str(archives[-1]), "mail": mail}
            else:
                result = observe(root, expected, args.get("full", {}), args.get("headers", {}))
            out = ctx.case_dir / f"mail-storage-observation-{time.time_ns()}.json"
            out.write_text(json.dumps(result, indent=2), encoding="utf-8")
            return str(out)
        except (AssertionError, OSError, sqlite3.Error, zipfile.BadZipFile) as error:
            last = error
            time.sleep(0.2)
    raise AssertionError(f"mail_storage_assert failed: {last}")
