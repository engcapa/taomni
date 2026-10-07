"""Credential-free canonical session/workspace relationships in an isolated QA profile."""
from __future__ import annotations

import json
import sqlite3
import subprocess
from contextlib import closing
from typing import Any

from .backup_policy import isolated_data_root


def setup(ctx: Any) -> None:
    native = (ctx.cfg.get("app") or {}).get("mode") == "native"
    root = "/preview"
    data_root = None
    if native:
        data_root = isolated_data_root(ctx)
        project = data_root / "qa-project"
        project.mkdir(parents=True, exist_ok=True)
        (project / "notes.txt").write_text("workspace fixture\n", encoding="utf-8")
        (project / "README.md").write_text("# QA workspace preview\n\nDurable workspace fixture.\n", encoding="utf-8")
        subprocess.run(["git", "init", str(project)], check=True, capture_output=True)
        root = project.as_posix()
    sessions = [
        {"id": identity, "name": name, "session_type": kind, "group_path": "User sessions / QA",
         "host": "", "port": 22, "username": None, "auth_method": "None", "options_json": "{}",
         "created_at": 1, "updated_at": 1, "last_connected_at": None, "sort_order": order}
        for order, (identity, name, kind) in enumerate([
            ("qa-local-shell", "QA local", "LocalShell"),
            ("qa-shared-ssh", "QA shared SSH", "SSH"),
            ("qa-mail", "QA mailbox", "Mail"),
        ])
    ]
    # Reuse the same job-owned SSH endpoint as ssh_required/sftp_required.
    # Passwords remain in the auth fixture environment, never in memberships.
    ssh = ctx.cfg.get("ssh") or {}
    if ssh.get("host") and ssh.get("port") and ssh.get("user"):
        sessions[1].update(host=ssh["host"], port=int(ssh["port"]), username=ssh["user"], auth_method="Password")
    workspaces = []
    for index, (identity, name, members) in enumerate([
        ("qa-workspace-main", "QA Main", ["qa-local-shell", "qa-shared-ssh"]),
        ("qa-workspace-remote", "QA Remote", ["qa-shared-ssh"]),
    ]):
        workspaces.append({
            "id": identity, "name": name, "description": "Isolated QA workspace", "revision": 1,
            "roots": [{"id": "qa-root", "name": "fixture", "path": root, "kind": "folder"}] if index == 0 else [],
            "looseFiles": [], "pinned": False, "order": index, "createdAt": 1, "updatedAt": 1,
            "lastOpenedAt": 2 - index,
            "navigation": {"activeSurface": "overview", "navigatorCollapsed": False, "rightPaneOpen": False},
            "memberships": [{"workspaceId": identity, "sessionId": session_id, "role": "primary" if order == 0 else "reference", "order": order, "pinned": False} for order, session_id in enumerate(members)],
        })
    if str(getattr(ctx, "case_id", "")).startswith("TC-WS-006"):
        workspaces[0]["memberships"].append({"workspaceId": "qa-workspace-main", "sessionId": "qa-missing", "role": "reference", "order": 3, "pinned": False})
    if native:
        assert data_root is not None
        with closing(sqlite3.connect(data_root / "taomni.db")) as db, db:
            db.executescript("""
                CREATE TABLE sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,session_type TEXT NOT NULL,group_path TEXT,host TEXT NOT NULL DEFAULT '',port INTEGER NOT NULL DEFAULT 22,username TEXT,auth_method TEXT NOT NULL,options_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_connected_at INTEGER,sort_order INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE workspaces(id TEXT PRIMARY KEY,legacy_recent_id TEXT UNIQUE,revision INTEGER NOT NULL,record_json TEXT NOT NULL);
                CREATE TABLE workspace_memberships(workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(workspace_id,session_id));
            """)
            for session in sessions:
                persisted = {**session, "auth_method": json.dumps(session["auth_method"])}
                db.execute(f"INSERT INTO sessions({','.join(persisted)}) VALUES({','.join('?' for _ in persisted)})", list(persisted.values()))
            for workspace in workspaces:
                db.execute("INSERT INTO workspaces VALUES(?,NULL,?,?)", (workspace["id"], workspace["revision"], json.dumps({**workspace, "memberships": []})))
                for member in workspace["memberships"]:
                    db.execute("INSERT INTO workspace_memberships VALUES(?,?,?)", (workspace["id"], member["sessionId"], json.dumps(member)))
        ctx.values["workspace_catalog_db"] = str(data_root / "taomni.db")
    else:
        seed = json.dumps({"sessions": sessions, "workspaces": workspaces})
        # Init-script ordering is not guaranteed by Playwright. If seed runs
        # first, prevent reset_db's later script from deleting seeded records.
        script = "(() => { if (sessionStorage.getItem('qa.workspace.seeded')) return; sessionStorage.setItem('qa.workspace.seeded','1'); sessionStorage.setItem('qa-ui-auto.reset-complete','1'); const seed=" + seed + "; localStorage.setItem('taomni.sessions.v1',JSON.stringify(seed.sessions)); localStorage.setItem('taomni.stub.workspaces.v1',JSON.stringify(seed.workspaces)); })();"
        ctx.page.context.add_init_script(script)
    ctx.values["workspace_catalog_root"] = root
