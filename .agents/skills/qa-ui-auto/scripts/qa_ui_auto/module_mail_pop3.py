"""Verify local originals and the UIDL ledger in the installed Mail store."""

from contextlib import closing
import hashlib
import json
import sqlite3
from pathlib import Path

from .module_retained_observation import ordinary
from .steps import StepError


def observe(data: Path, legacy: Path, subject: str | None = None) -> dict:
    receipts = list(data.glob("*.pop3-owner"))
    if len(receipts) != 1:
        raise StepError(f"Expected one POP3 owner receipt, found {len(receipts)}")
    receipt = receipts[0]
    ordinary(receipt)
    if receipt.read_bytes() != b"taomni-pop3-store-v1\n":
        raise StepError("Unexpected POP3 owner receipt")
    database = receipt.with_suffix(".db")
    ordinary(database)
    try:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
            uidls = conn.execute("SELECT account_id, uidl, fetched_at, deleted FROM mail_pop3_uidl ORDER BY uidl").fetchall()
            originals = conn.execute(
                """SELECT m.subject, r.raw
                   FROM mail_local_raw r
                   JOIN mail_messages m USING (account_id, folder, uid)
                   WHERE r.folder = 'INBOX' ORDER BY r.uid"""
            ).fetchall()
        previous = legacy / database.name
        if previous.exists():
            with closing(sqlite3.connect(previous.as_uri() + "?mode=ro", uri=True)) as conn:
                previous_uidls = conn.execute("SELECT COUNT(*) FROM mail_pop3_uidl").fetchone()[0]
                if previous_uidls:
                    raise StepError("The previous POP3 cache received new UIDLs")
    except sqlite3.Error as error:
        raise StepError(f"Cannot read the POP3 mailbox evidence: {error}") from error
    if not uidls or len(uidls) != len(originals):
        raise StepError("POP3 UIDLs and INBOX originals differ after synchronization")
    if any(not isinstance(raw, bytes) or not raw for _, raw in originals):
        raise StepError("The module did not retain the original message bytes")
    if subject and len([name for name, _ in originals if name == subject]) != 1:
        raise StepError("The module did not retain exactly one new POP3 original")
    return {
        "database": database.name,
        "ownerReceipt": receipt.name,
        "uidlCount": len(uidls),
        "uidlSha256": hashlib.sha256(json.dumps(uidls).encode("utf-8")).hexdigest(),
        "originals": [
            {"subject": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            for name, raw in originals
        ],
    }
