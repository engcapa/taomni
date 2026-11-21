"""Read-only, run-confined legacy row/file and pending-journal observations."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from .fixtures.backup_policy import isolated_data_root
from .fixtures import module_legacy_restore
from .fixtures.module_upgrade import CHAT_FILES, LEGACY_WAL_CASE
from .steps import StepError

AFTER_FIRST_INSTALL = "after-first-install"
VNC_RETAINED = "vnc-retained"


def wal_fingerprint(data, state):
    main = data / "taomni.db"
    wal = data / "taomni.db-wal"
    if wal.is_symlink() or not wal.is_file() or wal.stat().st_size <= 32:
        raise StepError("Upgrade WAL input is missing or was checkpointed")
    main_bytes, wal_bytes = main.read_bytes(), wal.read_bytes()
    main_digest, wal_digest = hashlib.sha256(main_bytes).digest(), hashlib.sha256(wal_bytes).digest()
    if main_digest.hex() != state["wal_main_sha256"]:
        raise StepError("Upgrade preflight checkpointed or changed its original main database")
    framed = (b"taomni.legacy.sqlite-with-wal.v1\0" + main_digest + len(main_bytes).to_bytes(8, "little")
              + wal_digest + len(wal_bytes).to_bytes(8, "little"))
    fingerprint = f"sha256:{hashlib.sha256(framed).hexdigest()}:bytes:{len(main_bytes) + len(wal_bytes)}"
    return fingerprint, {"mainSha256": main_digest.hex(), "walSha256": wal_digest.hex(),
                         "mainBytes": len(main_bytes), "walBytes": len(wal_bytes)}


def observe(data, state, phase):
    retained = state.get("retained") or {
        name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        for name, content in CHAT_FILES.items()}
    actual_names = {path.name for path in data.iterdir()
                    if path.name.startswith(("lanchat.sqlite", "lanchat.db"))}
    if actual_names != set(retained):
        raise StepError("Preflight/pending changed the retained LanChat file set")
    for name, expected in retained.items():
        path = data / name
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != expected["bytes"]
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected["sha256"]):
            raise StepError("Preflight/pending changed a retained LanChat file")
    database = data / "taomni.db"
    if database.is_symlink():
        raise StepError("Upgrade observation refuses a linked database")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        rows = connection.execute("SELECT id, session_type, options_json FROM sessions ORDER BY id").fetchall()
        if "certificate_pins" in state:
            pins = connection.execute("SELECT endpoint, fingerprint, updated_at FROM rdp_certificate_pins ORDER BY endpoint").fetchall()
            if pins != state["certificate_pins"]:
                raise StepError("Upgrade preflight/pending changed the original RDP certificate pins")
        if "server_configs" in state:
            servers = connection.execute("SELECT server_type, config_json, updated_at FROM server_configs ORDER BY server_type").fetchall()
            if servers != state["server_configs"]:
                raise StepError("Upgrade preflight/pending changed the original server configurations")
        if "full_sessions" in state:
            connection.row_factory = sqlite3.Row
            full_rows = [dict(row) for row in connection.execute("SELECT * FROM sessions ORDER BY id")]
            if full_rows != state["full_sessions"]:
                raise StepError("Upgrade changed complete old-version session records")
    expected = sorted((row["id"], row["session_type"], row["options_json"]) for row in state["sessions"])
    if rows != expected:
        raise StepError("Upgrade preflight/pending changed the original session records")
    absent = ["rdp-client", "vnc-client", "rdp-server", "vnc-server", "servers", "lanchat"]
    mail_preflight = "mail-accounts" in state.get("expected_items", [])
    if mail_preflight:
        cache = data / "mail-cache"
        if cache.exists() or cache.is_symlink():
            raise StepError("Opening a legacy profile without using Mail created default Mail storage")
        absent.append("mail")
    # The signed first-install probe has already verified the independent MFA package.
    if phase not in {AFTER_FIRST_INSTALL, VNC_RETAINED}:
        absent.append("mfa")
    if phase == VNC_RETAINED:
        absent.remove("vnc-client")
    for slug in absent:
        directory = data / "plugins" / slug
        if directory.exists() or directory.is_symlink():
            raise StepError(f"Pending migration created a module owner/code/data directory for {slug}")
    journal_path = data / "migration" / "journal.json"
    result = {"sessionTypes": [row[1] for row in rows], "retainedSha256": {
        name: value["sha256"] for name, value in retained.items()},
        "moduleDirectoriesAbsent": True, "checkedAbsentModuleDirectories": absent}
    if mail_preflight:
        result["unusedDefaultMailCacheAbsent"] = True
    expected_fingerprint = None
    if "wal_main_sha256" in state:
        expected_fingerprint, result["walInput"] = wal_fingerprint(data, state)
    if legacy_wal := state.get("legacy_wal_sources"):
        for name, expected_digest in legacy_wal.items():
            source = data / name
            if (source.is_symlink() or not source.is_file()
                    or hashlib.sha256(source.read_bytes()).hexdigest() != expected_digest):
                raise StepError("Upgrade changed the original NewMob database or its WAL")
        result["retainedLegacyDatabaseSha256"] = legacy_wal
    if phase == "preflight":
        if journal_path.exists():
            raise StepError("Read-only preflight wrote a migration journal")
    else:
        if journal_path.is_symlink():
            raise StepError("Upgrade observation refuses a linked journal")
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        expected_status = "complete" if phase == VNC_RETAINED else "pending"
        if journal.get("status") != expected_status or journal.get("to_core_api_version") != "1":
            raise StepError(f"Expected a {expected_status} upgrade journal")
        entries = journal.get("entries", [])
        expected_items = state.get("expected_items", ["vnc-sessions"])
        if len(entries) != len(expected_items):
            raise StepError(f"Upgrade must have exactly one journal entry per item (expected {len(expected_items)})")
        if [entry.get("item") for entry in entries] != expected_items:
            raise StepError("Pending migration has an incorrect owner or duplicate item")
        for entry in entries:
            expected_entry = ("committed", "taomni.db", "taomni.db") if phase == VNC_RETAINED else ("pending", "taomni.db", "")
            if (entry.get("state"), entry.get("source_path"), entry.get("target")) != expected_entry:
                raise StepError("Upgrade journal has an incorrect owner/source/state/target")
            if not re.fullmatch(r"sha256:[0-9a-f]{64}:bytes:[0-9]+", entry.get("source_fingerprint", "")):
                raise StepError("Pending migration lacks its actual source fingerprint")
            if expected_fingerprint and entry["source_fingerprint"] != expected_fingerprint:
                raise StepError("Pending migration fingerprint does not bind the committed WAL input")
        if phase in {"repeat", AFTER_FIRST_INSTALL} and journal != state.get("journal"):
            raise StepError("Repeated pending migration changed its journal instead of remaining idempotent")
        state["journal"] = journal
        result["journal"] = journal
    return result


def run(ctx, args):
    phases = {"preflight", "pending", "repeat", AFTER_FIRST_INSTALL, VNC_RETAINED, module_legacy_restore.PHASE}
    if not isinstance(args, dict) or set(args) != {"phase"} or args["phase"] not in phases:
        raise StepError("module_upgrade_probe requires a fixed registered phase")
    owner = getattr(ctx, "fixture_context", None) or ctx
    state = getattr(owner, "module_upgrade", None)
    case_id = getattr(owner, "case_id", None)
    if not state or case_id not in {"TC-MODULES-025", "TC-MODULES-027", "TC-MODULES-028", "TC-MODULES-030", "TC-MODULES-032", "TC-MODULES-049", module_legacy_restore.CASE_ID, LEGACY_WAL_CASE}:
        raise StepError("module_upgrade_probe requires its registered native legacy input fixture")
    if args["phase"] in {AFTER_FIRST_INSTALL, VNC_RETAINED} and case_id != "TC-MODULES-027":
        raise StepError("After-first-install verification requires the installed legacy roster case")
    if (args["phase"] == module_legacy_restore.PHASE) != (case_id == module_legacy_restore.CASE_ID):
        raise StepError("The staged-restore observation belongs to its own legacy profile case")
    data = isolated_data_root(owner)
    if data != state["root"]:
        raise StepError("Upgrade observation requires its own isolated profile")
    record = {"phase": args["phase"], "passed": False}
    try:
        if args["phase"] == module_legacy_restore.PHASE:
            record.update(module_legacy_restore.observe(data, state["sessions"][0]))
        else:
            record.update(observe(data, state, args["phase"]))
        if args["phase"] == VNC_RETAINED:
            artifact = json.loads((Path(ctx.case_dir) / "signed-vnc/provenance.json").read_text(encoding="utf-8"))
            module = data / "plugins/vnc-client"
            pointer = json.loads((module / "active.json").read_text(encoding="utf-8"))
            if pointer.get("activeVersion") != artifact["version"]:
                raise StepError("The VNC migration used a different signed module version")
            directory = module / "versions" / artifact["version"]
            for name, digest in [(".taomni-trust/package.taomni-plugin", artifact["sha256"]),
                                 ("frontend/index.js", artifact["frontendSha256"])]:
                if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
                    raise StepError("The VNC migration used a different signed payload")
            record["signedVncVersion"] = artifact["version"]
            record["signedVncSha256"] = artifact["sha256"]
        record["passed"] = True
        return "legacy upgrade " + args["phase"] + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-upgrade-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
