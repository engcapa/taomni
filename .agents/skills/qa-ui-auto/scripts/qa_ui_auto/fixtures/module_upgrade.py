"""Disposable previous-version session input; never seeds migration results."""
import json
from pathlib import Path

from .backup_policy import isolated_data_root
from .session_config import seed_sessions, ssh_session

PREVIEW_KEY = "taomni.preview.module-upgrade.v1"
CHAT_FILES = {"lanchat.sqlite": b"removed chat: not a SQLite database\n",
              "lanchat.db": b"second retained chat file\x00\xff"}


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


def setup(ctx):
    if ctx.case_id not in {"TC-MODULES-005", "TC-MODULES-025", "TC-MODULES-026"}:
        raise RuntimeError("module_upgrade requires a registered fixed-input case")
    vnc = ctx.case_id != "TC-MODULES-005"
    if (ctx.cfg.get("app") or {}).get("mode", "browser") == "browser":
        ctx.page.goto(ctx.cfg["app"]["base_url"])
        ctx.page.evaluate("value => localStorage.setItem('" + PREVIEW_KEY + "', value)",
                          json.dumps(preview_snapshot(vnc)))
        return
    data = isolated_data_root(ctx)
    rows = input_sessions(vnc)
    seed_sessions(ctx, rows)
    if vnc:
        for name, content in CHAT_FILES.items():
            with (data / name).open("xb") as stream:
                stream.write(content)
    ctx.module_upgrade = {"root": data, "sessions": rows, "journal": None}
    (Path(ctx.case_dir) / "module-upgrade-input.json").write_text(json.dumps({
        "scope": "synthetic previous-version row contract; not an installed 0.5.x upgrade",
        "dataRoot": str(data), "sessionTypes": [row["session_type"] for row in rows],
        "retainedFiles": list(CHAT_FILES) if vnc else [],
    }, indent=2) + "\n", encoding="utf-8")
