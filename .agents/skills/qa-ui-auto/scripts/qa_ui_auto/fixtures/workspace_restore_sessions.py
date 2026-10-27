"""Saved records only: every workspace tab is subsequently opened through the UI."""
from __future__ import annotations

import json
import secrets

from .session_config import seed_sessions


def setup(ctx):
    native = ctx.cfg.get("app", {}).get("mode") == "native"
    extra = ctx.case_id == "TC-WS-031"
    protocols = ["Mail", "Proxy", "S3", "AzureBlob", "Browser"] if extra else ["SSH", "SFTP", "LocalShell"]
    if not native and not extra:
        protocols += ["PostgreSQL", "Redis", "HBaseShell", "RDP", "VNC", "File"]
    ctx.values["workspace_restore_marker"] = "qa-workspace-restore-" + secrets.token_hex(5)
    ssh = ctx.cfg.get("ssh", {})
    rows = []
    for index, protocol in enumerate(protocols):
        name = "qa-restore-" + protocol.lower()
        host = str(ssh.get("host", "127.0.0.1")) if native and protocol in ("SSH", "SFTP") else "127.0.0.1"
        port = int(ssh.get("port", 22)) if native and protocol in ("SSH", "SFTP") else 22
        options = {"networkSettings": {"proxyKind": "none"}}
        if protocol == "LocalShell":
            host, port = "", 0
        elif protocol == "File":
            host = "/preview"
        elif protocol == "Mail":
            options.update(mailEmailAddress="qa@example.test", mailImapSecurity="None", mailSmtpSecurity="None")
        elif protocol in ("S3", "AzureBlob"):
            options.update(provider="minio" if protocol == "S3" else "azure", endpoint="http://127.0.0.1:9")
        elif protocol == "Browser":
            host = "https://example.test/qa-workspace"
        rows.append({
            "id": name, "name": name, "session_type": protocol, "group_path": None,
            "host": host, "port": port, "username": str(ssh.get("user", "qa")),
            "auth_method": "Password" if native and protocol in ("SSH", "SFTP") else "None",
            "options_json": json.dumps(options), "created_at": 1, "updated_at": 1,
            "last_connected_at": None, "sort_order": index,
        })
    if native:
        seed_sessions(ctx, rows)
    else:
        ctx.page.goto(ctx.cfg["app"]["base_url"], wait_until="commit")
        ctx.page.evaluate("rows => window.localStorage.setItem('taomni.sessions.v1', JSON.stringify(rows))", rows)


def teardown(ctx):
    # The run owns these records and retains its isolated profile as evidence.
    pass
