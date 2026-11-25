"""Read the signed Mail rule and its owner from the disposable profile."""

from contextlib import closing
import json
import sqlite3

from .module_retained_observation import ordinary
from .steps import StepError


def _rules(directory):
    matches = []
    for path in sorted(directory.glob("*.db")):
        ordinary(path)
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='mail_filters'").fetchone():
                continue
            for account, encoded in db.execute("SELECT account_id,filter_json FROM mail_filters"):
                rule = json.loads(encoded)
                if rule["name"] == "QA body archive":
                    matches.append((path, account, rule))
    return matches


def observe(module_data, legacy_cache):
    if _rules(legacy_cache):
        raise StepError("The new rule was written to the legacy Mail cache")
    rows = _rules(module_data)
    if len(rows) != 1:
        raise StepError(f"Expected one signed Mail filter, found {len(rows)}")
    path, account, rule = rows[0]
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM mail_filter_owners WHERE account_id=?", (account,)).fetchone():
            raise StepError("The signed host has not recorded the filter owner")
    if (rule["conditions"] != [{"field": "body", "op": "contains", "value": "invoice marker"}]
            or rule["actions"] != [{"kind": "moveTo", "value": "Archive"}]
            or not rule["enabled"] or not rule["onIncoming"]):
        raise StepError("The module mailbox lost the incoming body condition or archive action")
    return {"database": path.name, "account": account, "rule": rule}
