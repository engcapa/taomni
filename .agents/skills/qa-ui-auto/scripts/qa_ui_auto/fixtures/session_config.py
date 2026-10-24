"""Legacy session inputs and an unreachable proxy, confined to each QA profile."""
from __future__ import annotations

import json
import socket
import sqlite3
from pathlib import Path

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from .backup_policy import isolated_data_root


def ssh_session(name, options, *, host="ssh.example.test", port=22, user="qa", auth="Agent"):
    return {
        "id": name, "name": name, "session_type": "SSH", "group_path": None,
        "host": host, "port": int(port), "username": user, "auth_method": auth,
        "options_json": json.dumps(options), "created_at": 1, "updated_at": 1,
        "last_connected_at": None, "sort_order": 0,
    }


def seed_sessions(ctx, sessions):
    """Seed previous-version rows before startup; subsequent saves use production IPC."""
    data = isolated_data_root(ctx)
    with sqlite3.connect(data / "taomni.db") as db:
        # Same persisted row contract as src-tauri/src/session/db.rs. The app
        # initializes the remaining tables when this disposable profile starts.
        db.execute("""CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, session_type TEXT NOT NULL,
            group_path TEXT, host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 22,
            username TEXT, auth_method TEXT NOT NULL DEFAULT '\"Password\"',
            options_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, last_connected_at INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0)""")
        columns = list(sessions[0])
        db.executemany(
            "INSERT INTO sessions (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")",
            [tuple(json.dumps(row[key]) if key == "auth_method" else row[key] for key in columns) for row in sessions],
        )


def setup_unreachable_proxy(ctx):
    # A bound, non-listening loopback port cannot accept a proxy connection.
    # Keep ownership until teardown to avoid another process claiming the port.
    isolated_data_root(ctx)
    expected = native_isolation_env(Path(ctx.report_root))
    config_root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    # Match resolved_config_dir -> qa_override_path in src-tauri/src/lib.rs:
    # macOS/Windows explicit overrides add the QA identifier; Linux XDG does not.
    if "NEWMOB_CONFIG_DIR" in expected:
        config_root = config_root / QA_APP_ID
    proxy_path = config_root / "taomni" / "proxy.json"
    if not proxy_path.resolve().is_relative_to(Path(ctx.report_root).resolve()):
        raise RuntimeError("Proxy fixture refuses a path outside the QA profile")
    ctx._session_proxy_previous = proxy_path.read_bytes() if proxy_path.exists() else None
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    ctx._session_proxy_socket = listener
    proxy_path.parent.mkdir(parents=True, exist_ok=True)
    proxy_path.write_text(json.dumps({
        "enabled": True, "mode": "manual", "kind": "http", "host": "127.0.0.1",
        "port": listener.getsockname()[1], "username": "", "password_ref": "", "session_id": "",
    }), encoding="utf-8")
    # Retain the path for independent fixture verification, without a product API.
    ctx.values["unreachable_proxy_path"] = str(proxy_path)


def teardown_unreachable_proxy(ctx):
    listener = getattr(ctx, "_session_proxy_socket", None)
    if listener:
        listener.close()
        ctx._session_proxy_socket = None
    path = ctx.values.get("unreachable_proxy_path")
    if path:
        previous = ctx._session_proxy_previous
        if previous is None:
            Path(path).unlink(missing_ok=True)
        else:
            Path(path).write_bytes(previous)


def seed_legacy_scp(ctx, config):
    fast = ctx.case_id.endswith("002")
    name = "qa-scp-fast" if fast else "qa-scp"
    seed_sessions(ctx, [ssh_session(
        name, {"sshBrowser": "scp-fast" if fast else "scp", "networkSettings": {"proxyKind": "none"}},
        host=config["host"], port=config["throttled_port"] if ctx.case_id.endswith("003") else config["port"],
        user=config["user"], auth={"PrivateKey": {"key_path": config["key_path"]}},
    )])
