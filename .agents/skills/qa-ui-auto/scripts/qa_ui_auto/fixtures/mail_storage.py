"""Disposable full-MIME fixture and independent byte oracle; never personal data."""
from __future__ import annotations
import base64
import hashlib
import json
from pathlib import Path
from typing import Any
from .backup_policy import isolated_data_root
from .. import mail_fake_server


def setup(ctx: Any) -> None:
    root = Path(ctx.case_dir).resolve() / "mail-storage-fixture"
    root.mkdir(parents=True, exist_ok=True)
    for name in ("mail-a", "mail-b"):
        (root / name).mkdir(exist_ok=True)
    ctx.values.update(mail_storage_a=str(root / "mail-a"), mail_storage_b=str(root / "mail-b"), mail_expected=str(root / "expected.json"))
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        ctx.values.update(mail_imap_port="993", mail_smtp_port="465", mail_host="imap.example.com")
        return
    data = isolated_data_root(ctx)
    ctx.values["mail_qa_data"] = str(data)
    # Disable automatic backups so manual include/exclude assertions have one owner.
    (data / "backup_policy.json").write_text(json.dumps({"autoBackupEnabled": False, "defaultScope": "core", "maxRetainedCopies": 30}), encoding="utf-8")
    ctx.values["mail_host"] = "127.0.0.1"
    server = mail_fake_server.ACTIVE
    if server is None:
        raise RuntimeError("mail_storage requires mail_server first")
    server.state.archive_chunk_delay = 1
    expected = {}
    with server.state.lock:
        for folder in server.state.folders.values():
            folder.messages.clear()
        for folder_name in ("INBOX", "Archive"):
            for index in range(2):
                subject = f"Complete {folder_name} {index}"
                attachment = bytes(range(256)) * 2400
                raw = (f"From: qa@example.com\r\nTo: reader@example.com\r\nSubject: {subject}\r\n"
                       f"MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=qa-full\r\n\r\n"
                       f"--qa-full\r\nContent-Type: text/plain\r\n\r\nOffline body {subject}\r\n"
                       f"--qa-full\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=complete.bin\r\n"
                       f"Content-Transfer-Encoding: base64\r\n\r\n").encode() + base64.encodebytes(attachment).replace(b"\n", b"\r\n") + b"\r\n--qa-full--\r\n"
                uid = server.state.append_raw(folder_name, raw, [])
                expected[f"{folder_name}/{uid}"] = {"sha256": hashlib.sha256(raw).hexdigest(), "rawSize": len(raw), "attachmentSha256": hashlib.sha256(attachment).hexdigest()}
    (root / "expected.json").write_text(json.dumps(expected), encoding="utf-8")


def setup_batched(ctx: Any) -> None:
    """Several header pages with small originals and observable per-message latency."""
    setup(ctx)
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("mail_archive_batches requires native IMAP and disk observations")
    server = mail_fake_server.ACTIVE
    server.state.header_fetch_delay = 0.1
    server.state.archive_chunk_delay = 0.05
    expected = {}
    attachment = b"batched-archive-attachment"
    with server.state.lock:
        for folder in server.state.folders.values():
            folder.messages.clear()
        for index in range(350):
            raw = (f"From: qa@example.com\r\nTo: reader@example.com\r\nSubject: Batch mail {index:04d}\r\n"
                   "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=batch\r\n\r\n"
                   f"--batch\r\nContent-Type: text/plain\r\n\r\nReadable before history completes {index:04d}\r\n"
                   "--batch\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=batch.bin\r\n"
                   "Content-Transfer-Encoding: base64\r\n\r\n").encode() + base64.b64encode(attachment) + b"\r\n--batch--\r\n"
            uid = server.state.append_raw("INBOX", raw, [])
            expected[f"INBOX/{uid}"] = {"sha256": hashlib.sha256(raw).hexdigest(), "rawSize": len(raw), "attachmentSha256": hashlib.sha256(attachment).hexdigest()}
    Path(ctx.values["mail_expected"]).write_text(json.dumps(expected), encoding="utf-8")
