"""Observe the calendar cache written by the signed Mail host."""
from contextlib import closing
import json
import sqlite3

from .module_retained_observation import ordinary
from .steps import StepError


SUMMARY = "Signed planning meeting"


def matching_rows(directory):
    for path in sorted(directory.glob("*.db")):
        ordinary(path)
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='mail_calendar_events' AND type='table'").fetchone():
                continue
            for account, href, event in db.execute("SELECT account_id, href, event_json FROM mail_calendar_events"):
                item = json.loads(event)
                if item.get("summary") == SUMMARY:
                    yield path, account, href, item["uid"]


def observe(module, legacy):
    if any(matching_rows(legacy)):
        raise StepError("The desktop wrote the agenda event to the legacy cache")
    rows = list(matching_rows(module))
    if len(rows) != 1:
        raise StepError(f"Expected one agenda event in the module mailbox, found {len(rows)}")
    database, account, href, uid = rows[0]
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        owned = db.execute("SELECT 1 FROM mail_agenda_owners WHERE account_id=?", [account]).fetchone()
        synced = db.execute("""SELECT collection_url, last_sync, last_error FROM mail_caldav_state
                               WHERE account_id=?""", [account]).fetchone()
    if not owned or not synced or not synced[0] or not synced[1] or synced[2]:
        raise StepError("The agenda owner and calendar discovery state must accompany the event")
    return {"database": database.name, "account": account, "href": href, "uid": uid}
