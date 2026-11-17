"""Disposable previous-version session input; never seeds migration results."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3

from .backup_policy import isolated_data_root
from .session_config import seed_sessions, ssh_session

PREVIEW_KEY = "taomni.preview.module-upgrade.v1"
CHAT_FILES = {"lanchat.sqlite": b"removed chat: not a SQLite database\n",
              "lanchat.db": b"second retained chat file\x00\xff"}
SERVER_ITEMS = ["server-configs", "rdp-server-configs", "vnc-server-configs"]
SERVER_ROWS = [(name, json.dumps({"autoStart": False, "fixture": "qa-legacy-" + name,
                                "passwordRef": "vault:qa-unused"}), 1)
               for name in ["http", "rdp", "vnc"]]


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


def setup(ctx):
    if ctx.case_id not in {"TC-MODULES-005", "TC-MODULES-025", "TC-MODULES-026", "TC-MODULES-028", "TC-MODULES-029"}:
        raise RuntimeError("module_upgrade requires a registered fixed-input case")
    server_profile = ctx.case_id in {"TC-MODULES-028", "TC-MODULES-029"}
    vnc = ctx.case_id != "TC-MODULES-005" and not server_profile
    if (ctx.cfg.get("app") or {}).get("mode", "browser") == "browser":
        ctx.page.goto(ctx.cfg["app"]["base_url"])
        ctx.page.evaluate("value => localStorage.setItem('" + PREVIEW_KEY + "', value)",
                          json.dumps(preview_server_snapshot() if server_profile else preview_snapshot(vnc)))
        return
    data = isolated_data_root(ctx)
    rows = input_sessions(vnc)
    seed_sessions(ctx, rows)
    if vnc or server_profile:
        for name, content in CHAT_FILES.items():
            with (data / name).open("xb") as stream:
                stream.write(content)
    ctx.module_upgrade = {"root": data, "sessions": rows, "journal": None}
    if server_profile:
        with closing(sqlite3.connect(data / "taomni.db")) as db, db:
            db.execute("CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            db.executemany("INSERT INTO server_configs VALUES (?, ?, ?)", SERVER_ROWS)
        ctx.module_upgrade.update(expected_items=SERVER_ITEMS, server_configs=SERVER_ROWS)
    (Path(ctx.case_dir) / "module-upgrade-input.json").write_text(json.dumps({
        "scope": "synthetic previous-version row contract; not an installed 0.5.x upgrade",
        "dataRoot": str(data), "sessionTypes": [row["session_type"] for row in rows],
        "retainedFiles": list(CHAT_FILES) if vnc or server_profile else [],
        "serverTypes": [row[0] for row in SERVER_ROWS] if server_profile else [],
    }, indent=2) + "\n", encoding="utf-8")
