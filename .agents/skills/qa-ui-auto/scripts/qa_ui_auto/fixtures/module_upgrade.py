"""Disposable previous-version session input; never seeds migration results."""
import json
import hashlib
from contextlib import closing
from pathlib import Path
import sqlite3

from .backup_policy import isolated_data_root
from . import module_legacy_restore
from .session_config import seed_sessions, ssh_session

PREVIEW_KEY = "taomni.preview.module-upgrade.v1"
CHAT_FILES = {"lanchat.sqlite": b"removed chat: not a SQLite database\n",
              "lanchat.db": b"second retained chat file\x00\xff"}
SERVER_ITEMS = ["server-configs", "rdp-server-configs", "vnc-server-configs"]
SERVER_ROWS = [(name, json.dumps({"autoStart": False, "fixture": "qa-legacy-" + name,
                                "passwordRef": "vault:qa-unused"}), 1)
               for name in ["http", "rdp", "vnc"]]
CLIENT_ITEMS = ["rdp-vnc-sessions", "vnc-sessions", "rdp-certificate-pins"]
PIN_ROWS = [("qa-upgrade.invalid:3389", "ab" * 32, 1)]
MAIL_CASES = {"TC-MODULES-049", "TC-MODULES-050"}
LEGACY_WAL_CASE = "TC-MODULES-051"
RDP_PIN_CASE = "TC-MODULES-056"
RDP_RESTORE_CASE = "TC-MODULES-058"


def input_sessions(vnc):
    rows = [ssh_session("qa-upgrade-ssh", {})]
    if vnc:
        row = ssh_session("qa-upgrade-vnc", {"readOnly": True}, port=5900)
        row["session_type"] = "VNC"
        rows.append(row)
    return rows


def preview_snapshot(vnc):
    return {
        "from_version": "0.5.x", "database_path": "preview/taomni.db",
        "database_tables": ["sessions", "rdp_certificate_pins", "server_configs"],
        "candidates": [{"item": "vnc-sessions", "plugin_slug": "vnc-client",
                        "evidence": ["taomni.db"]}] if vnc else [],
        "source_fingerprints": {}, "vault": None,
        "retained_paths": ["preview/" + name for name in CHAT_FILES] if vnc else [],
    }


def preview_server_snapshot():
    snapshot = preview_snapshot(False)
    snapshot["candidates"] = [
        {"item": item, "plugin_slug": slug, "evidence": ["taomni.db"]}
        for item, slug in zip(SERVER_ITEMS, ["servers", "rdp-server", "vnc-server"])]
    snapshot["retained_paths"] = ["preview/" + name for name in CHAT_FILES]
    return snapshot


def client_sessions():
    rows = input_sessions(True)
    rdp = ssh_session("qa-upgrade-rdp", {"readOnly": True}, port=3389)
    rdp["session_type"] = "RDP"
    return rows + [rdp]


def preview_client_snapshot():
    snapshot = preview_snapshot(True)
    snapshot["candidates"] = [
        {"item": item, "plugin_slug": slug, "evidence": ["taomni.db"]}
        for item, slug in zip(CLIENT_ITEMS, ["rdp-client", "vnc-client", "rdp-client"])]
    return snapshot


def setup(ctx):
    if ctx.case_id not in {"TC-MODULES-005", "TC-MODULES-025", "TC-MODULES-026", "TC-MODULES-028", "TC-MODULES-029", "TC-MODULES-030", "TC-MODULES-031", "TC-MODULES-032", "TC-MODULES-036", "TC-MODULES-037", "TC-MODULES-040", "TC-MODULES-046", module_legacy_restore.CASE_ID, LEGACY_WAL_CASE, RDP_PIN_CASE, RDP_RESTORE_CASE, *MAIL_CASES}:
        raise RuntimeError("module_upgrade requires a registered fixed-input case")
    server_profile = ctx.case_id in {"TC-MODULES-028", "TC-MODULES-029"}
    client_profile = ctx.case_id in {"TC-MODULES-030", "TC-MODULES-031", RDP_PIN_CASE, RDP_RESTORE_CASE}
    mfa_profile = ctx.case_id in {"TC-MODULES-036", "TC-MODULES-037"}
    mail_profile = ctx.case_id in MAIL_CASES
    vnc = ctx.case_id not in {"TC-MODULES-005", "TC-MODULES-040", "TC-MODULES-046", module_legacy_restore.CASE_ID} and not (server_profile or mail_profile)
    if (ctx.cfg.get("app") or {}).get("mode", "browser") == "browser":
        ctx.page.goto(ctx.cfg["app"]["base_url"])
        snapshot = preview_client_snapshot() if client_profile else preview_server_snapshot() if server_profile else preview_snapshot(vnc)
        if mfa_profile:
            snapshot = preview_snapshot(False)
            snapshot["candidates"] = [{"item": "mfa", "plugin_slug": "mfa", "evidence": ["mfa.db"]}]
        if mail_profile:
            snapshot["candidates"] = [{"item": "mail-accounts", "plugin_slug": "mail", "evidence": ["taomni.db"]}]
        ctx.page.evaluate("value => localStorage.setItem('" + PREVIEW_KEY + "', value)", json.dumps(snapshot))
        return
    if mfa_profile:
        # The native case creates the Vault and account through the actual UI.
        return
    data = isolated_data_root(ctx)
    rows = client_sessions() if client_profile else input_sessions(vnc)
    if mail_profile:
        cache = Path(ctx.case_dir).resolve() / "legacy-mail-cache"
        cache.mkdir()
        message = cache / "retained.eml"
        content = b"Subject: Retained QA mail\r\n\r\nOriginal message bytes.\r\n"
        message.write_bytes(content)
        ctx.values.update(legacy_mail_cache_path=str(message), legacy_mail_cache_hash=hashlib.sha256(content).hexdigest())
        for suffix, options in [("default", {}), ("custom", {"mailStorageDirectory": str(cache)})]:
            row = ssh_session(f"qa-upgrade-mail-{suffix}", {**options, "passwordRef": "vault:qa-mail"},
                              host="imap.example.test", port=993, auth="Password")
            row["session_type"] = "Mail"
            rows.append(row)
    seed_sessions(ctx, rows)
    retain_chat = vnc or server_profile or mail_profile
    if retain_chat:
        for name, content in CHAT_FILES.items():
            with (data / name).open("xb") as stream:
                stream.write(content)
    ctx.module_upgrade = {"root": data, "sessions": rows, "journal": None}
    if mail_profile:
        ctx.module_upgrade["expected_items"] = ["mail-accounts"]
    if ctx.case_id == module_legacy_restore.CASE_ID:
        module_legacy_restore.stage(ctx, data, rows[0])
    if ctx.case_id in {"TC-MODULES-032", LEGACY_WAL_CASE}:
        _seed_wal_input(ctx, data, rows)
    if client_profile:
        with closing(sqlite3.connect(data / "taomni.db")) as db, db:
            db.execute("CREATE TABLE rdp_certificate_pins (endpoint TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            db.executemany("INSERT INTO rdp_certificate_pins VALUES (?, ?, ?)", PIN_ROWS)
        ctx.module_upgrade.update(expected_items=CLIENT_ITEMS, certificate_pins=PIN_ROWS)
    if ctx.case_id == RDP_RESTORE_CASE:
        previous = data / "plugins/rdp-client/data/data.db"
        previous.parent.mkdir(parents=True)
        with closing(sqlite3.connect(previous)) as db, db:
            db.execute("CREATE TABLE rdp_certificate_pins (endpoint TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            db.execute("INSERT INTO rdp_certificate_pins VALUES ('later.invalid:3389', ?, 2)", ["cd" * 32])
        rdp_session = next(row for row in rows if row["session_type"] == "RDP")
        ctx.module_upgrade["restored_rdp_session"] = rdp_session
        module_legacy_restore.stage(ctx, data, rdp_session)
    if server_profile:
        with closing(sqlite3.connect(data / "taomni.db")) as db, db:
            db.execute("CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            db.executemany("INSERT INTO server_configs VALUES (?, ?, ?)", SERVER_ROWS)
        ctx.module_upgrade.update(expected_items=SERVER_ITEMS, server_configs=SERVER_ROWS)
    (Path(ctx.case_dir) / "module-upgrade-input.json").write_text(json.dumps({
        "scope": "synthetic previous-version row contract; not an installed 0.5.x upgrade",
        "dataRoot": str(data), "sessionTypes": [row["session_type"] for row in rows],
        "retainedFiles": list(CHAT_FILES) if retain_chat else [],
        "serverTypes": [row[0] for row in SERVER_ROWS] if server_profile else [],
        "certificatePinCount": len(PIN_ROWS) if client_profile else 0,
    }, indent=2) + "\n", encoding="utf-8")


def _seed_wal_input(ctx, data, rows):
    """Keep the real writer open so candidate restarts cannot hide the WAL input."""
    path = data / "taomni.db"
    renamed_source = ctx.case_id == LEGACY_WAL_CASE
    if renamed_source:
        path = path.rename(data / "newmob.db")
    connection = sqlite3.connect(path)
    try:
        if connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
            raise RuntimeError("Upgrade WAL fixture requires actual SQLite WAL mode")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        main_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        vnc = next(row for row in rows if row["session_type"] == "VNC")
        vnc["options_json"] = json.dumps({**json.loads(vnc["options_json"]), "upgradeWal": "committed-v1"})
        connection.execute("UPDATE sessions SET options_json = ? WHERE id = ?", [vnc["options_json"], vnc["id"]])
        connection.commit()
        if hashlib.sha256(path.read_bytes()).hexdigest() != main_sha256:
            raise RuntimeError("Upgrade WAL fixture unexpectedly checkpointed its committed input")
        if renamed_source:
            wal = data / "newmob.db-wal"
            wal_bytes = wal.read_bytes()
            if len(wal_bytes) <= 32:
                raise RuntimeError("The original database WAL must contain the committed change")
            ctx.module_upgrade["legacy_wal_sources"] = {
                path.name: main_sha256, wal.name: hashlib.sha256(wal_bytes).hexdigest(),
            }
        else:
            ctx.module_upgrade["wal_main_sha256"] = main_sha256
        ctx.module_upgrade["wal_connection"] = connection
    except BaseException:
        connection.close()
        raise


def teardown(ctx):
    state = getattr(ctx, "module_upgrade", None) or {}
    connection = state.pop("wal_connection", None)
    if connection is not None:
        connection.close()
