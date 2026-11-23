"""Inspect a saved IMAP account's actual module database and ownership receipt."""

from contextlib import closing
import hashlib
import sqlite3

from .module_retained_observation import ordinary
from .steps import StepError


def observe(profile, phase, previous):
    core = profile / "taomni.db"
    ordinary(core)
    with closing(sqlite3.connect(core.as_uri() + "?mode=ro", uri=True)) as db:
        accounts = db.execute(
            "SELECT id FROM sessions WHERE session_type='Mail' AND name=?",
            ("QA owned IMAP",),
        ).fetchall()
    if len(accounts) != 1:
        raise StepError(f"Expected one saved IMAP account, got {len(accounts)}")
    account = accounts[0][0]
    cleaned = "".join(
        value if value.isascii() and (value.isalnum() or value in "-_") else "_"
        for value in account
    ).strip("_")[:80] or "mail"
    stem = f"{cleaned}-{hashlib.sha256(account.encode()).hexdigest()[:16]}"
    module = profile / "plugins" / "mail" / "data"
    receipt = module / f"{stem}.imap-owner"
    database = module / f"{stem}.db"
    ordinary(receipt)
    ordinary(database)
    if receipt.read_text(encoding="utf-8") != f"taomni-imap-store-v1\n{stem}\n":
        raise StepError("The ownership receipt does not identify the saved IMAP account")
    legacy = profile / "mail-cache"
    if any((legacy / f"{stem}{suffix}").exists() for suffix in (".db", ".redirect.json", ".mail")):
        raise StepError("Saving or syncing the new account created a legacy mailbox")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        counts = dict(db.execute(
            "SELECT subject, count(*) FROM mail_messages WHERE account_id=?1 AND folder='INBOX' GROUP BY subject",
            (account,),
        ))
    if phase == "imap-account-created" and counts:
        raise StepError("The new account was expected to own an empty cache before connecting")
    if phase == "imap-account-synced" and counts.get("Fresh ownership 0001") != 1:
        raise StepError("The new mail was not committed exactly once to the module's account database")
    identity = {"accountId": account, "database": database.name, "receipt": receipt.name}
    if previous is not None and identity != previous:
        raise StepError("Sync or reopening changed the account database identity")
    return identity
