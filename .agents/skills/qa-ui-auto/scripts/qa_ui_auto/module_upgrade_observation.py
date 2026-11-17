"""Read-only, run-confined legacy row/file and pending-journal observations."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_upgrade import CHAT_FILES
from .steps import StepError


def observe(data, state, phase):
    for name, content in CHAT_FILES.items():
        path = data / name
        if path.is_symlink() or path.read_bytes() != content:
            raise StepError("Preflight/pending changed a retained LanChat file")
    database = data / "taomni.db"
    if database.is_symlink():
        raise StepError("Upgrade observation refuses a linked database")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        rows = connection.execute("SELECT id, session_type, options_json FROM sessions ORDER BY id").fetchall()
    expected = sorted((row["id"], row["session_type"], row["options_json"]) for row in state["sessions"])
    if rows != expected:
        raise StepError("Upgrade preflight/pending changed the original session records")
    # This case installs no package. A pending journal must confer no execution.
    plugins = data / "plugins"
    for slug in ["rdp-client", "vnc-client", "servers", "mfa", "lanchat"]:
        if (plugins / slug).exists() or (plugins / slug).is_symlink():
            raise StepError("Pending migration created a module owner/code/data directory")
    journal_path = data / "migration" / "journal.json"
    result = {"sessionTypes": [row[1] for row in rows], "retainedSha256": {
        name: hashlib.sha256(content).hexdigest() for name, content in CHAT_FILES.items()},
        "moduleDirectoriesAbsent": True}
    if phase == "preflight":
        if journal_path.exists():
            raise StepError("Read-only preflight wrote a migration journal")
    else:
        if journal_path.is_symlink():
            raise StepError("Upgrade observation refuses a linked journal")
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        if journal.get("status") != "pending" or journal.get("to_core_api_version") != "1":
            raise StepError("Unperformed upgrade was incorrectly marked complete")
        entries = journal.get("entries", [])
        if len(entries) != 1:
            raise StepError("VNC-only upgrade must have exactly one journal item")
        entry = entries[0]
        if (entry.get("item"), entry.get("state"), entry.get("source_path"), entry.get("target")) != (
                "vnc-sessions", "pending", "taomni.db", ""):
            raise StepError("Pending VNC item has an incorrect owner/source/state/target")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}:bytes:[0-9]+", entry.get("source_fingerprint", "")):
            raise StepError("Pending VNC item lacks its actual source fingerprint")
        if phase == "repeat" and journal != state.get("journal"):
            raise StepError("Repeated pending migration changed its journal instead of remaining idempotent")
        state["journal"] = journal
        result["journal"] = journal
    return result


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args["phase"] not in {"preflight", "pending", "repeat"}:
        raise StepError("module_upgrade_probe requires a fixed registered phase")
    owner = getattr(ctx, "fixture_context", None) or ctx
    state = getattr(owner, "module_upgrade", None)
    if not state or getattr(owner, "case_id", None) != "TC-MODULES-025":
        raise StepError("module_upgrade_probe requires its native VNC-only input fixture")
    data = isolated_data_root(owner)
    if data != state["root"]:
        raise StepError("Upgrade observation requires its own isolated profile")
    record = {"phase": args["phase"], "passed": False}
    try:
        record.update(observe(data, state, args["phase"]))
        record["passed"] = True
        return "legacy upgrade " + args["phase"] + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-upgrade-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
