"""Observe the card written by the desktop in the signed Mail module's database."""
from contextlib import closing
import json
import sqlite3

from .module_retained_observation import ordinary
from .steps import StepError

NAME = "Signed Book Contact"
EMAIL = "signed.book@example.org"


def matching_rows(directory, previous):
    rows = []
    for path in sorted(directory.glob("*.db")):
        ordinary(path)
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='mail_cards' AND type='table'").fetchone():
                continue
            query = "SELECT account_id,uid,card_json,deleted FROM mail_cards WHERE display_name=? OR emails=?"
            params = [NAME, EMAIL]
            if previous:
                query += " OR (account_id=? AND uid=?)"
                params.extend([previous["account"], previous["uid"]])
            rows.extend((path, *row) for row in db.execute(query, params))
    return rows


def observe(module, legacy, phase, previous):
    if matching_rows(legacy, previous):
        raise StepError("The desktop wrote the address-book contact to the legacy cache")
    rows = matching_rows(module, previous)
    if phase == "contact-deleted":
        if not previous or rows or not (module / previous["database"]).is_file():
            raise StepError("Deleting the contact must remove its exact row from the retained mailbox")
        return {**previous, "deleted": True}
    if len(rows) != 1:
        raise StepError(f"Expected one contact in module storage, found {len(rows)}")
    path, account, uid, card_json, deleted = rows[0]
    card = json.loads(card_json)
    if not account or not uid or card.get("uid") != uid or deleted or card.get("displayName") != NAME or card.get("emails") != [EMAIL]:
        raise StepError("The stored Mail contact lost its identity, name or address")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM mail_address_book_owners WHERE account_id=?", [account]).fetchone():
            raise StepError("The Mail host did not claim the address book")
    observed = {"database": path.name, "account": account, "uid": uid, "email": EMAIL}
    if phase == "contact-retained" and observed != previous:
        raise StepError("The contact changed while disabling Mail")
    return observed
