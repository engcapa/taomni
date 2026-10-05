"""Input-only saved-session/workspace catalogue for Shell renderer workflows."""
from __future__ import annotations
import json
from pathlib import Path


def setup(ctx):
    if ctx.cfg.get("app", {}).get("mode") != "browser":
        raise RuntimeError("shell_browser_catalog requires the browser IPC stub")
    sessions = []
    for index, (ident, name, kind, host) in enumerate([
        ("a", "qa-alpha", "SSH", "alpha.invalid"),
        ("b", "qa-beta", "SSH", "beta.invalid"),
        ("s", "SFTP 文件", "SFTP", "alpha.invalid"),
        ("d", "MySQL 数据库", "MySQL", "alpha.invalid"),
        ("f", "Local 文件", "File", "/preview"),
    ]):
        sessions.append(dict(id="shell-"+ident, name=name, session_type=kind, host=host, port=22 if kind in ["SSH", "SFTP"] else 3306,
                             username="qa", auth_method="Agent", options_json="{}", group_path="Shell/甲" if ident != "b" else "Shell/乙",
                             created_at=1000, updated_at=1000, last_connected_at=2000-index, sort_order=index))
    case = ctx.case_id
    if case == "TC-SHELL-B43":
        sessions[0]["options_json"] = json.dumps({"proxyPass": "qa-export-must-be-excluded"})
        # A chooser supplies only portable connection data; product import,
        # duplicate detection and persistence still run through the real UI.
        source = Path(ctx.case_dir) / "shell-import.json"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(json.dumps({"format": "taomni.sessions", "schema_version": 1, "sessions": [
            {"name": "qa-alpha", "type": "SSH", "host": "alpha.invalid", "port": 22, "username": "qa", "auth": {"kind": "agent"}, "folder_path": "Shell/甲", "options": {}},
            {"name": "SHELL imported", "type": "SSH", "host": "imported.invalid", "port": 22, "username": "qa", "auth": {"kind": "agent"}, "folder_path": "Shell/导入", "options": {}},
        ]}, ensure_ascii=False), encoding="utf-8")
        ctx.values.update(shell_import=source.as_posix(), shell_export=(source.parent / "shell-export.json").as_posix())
    if case in {"TC-SHELL-B06", "TC-SHELL-B38"}:
        for ident, kind, port, options in [
            ("rdp", "RDP", 3389, {}), ("vnc", "VNC", 5900, {}),
            ("redis", "Redis", 6379, {"database": "2"}),
            ("hbase", "HBaseShell", 8080, {"hbaseConnectionMode": "rest", "hbaseNamespace": "qa"}),
            ("proxy", "Proxy", 8080, {"proxyKind": "http"}),
            ("object", "S3", 9000, {"s3AuthMode": "anonymous"}),
            ("mail", "Mail", 993, {"emailAddress": "qa@example.com"}),
        ]:
            if case == "TC-SHELL-B38" and ident != "proxy":
                continue
            sessions.append(dict(sessions[0], id=f"shell-{ident}", name=f"SHELL-TYPE-{ident}", session_type=kind,
                                 port=port, options_json=json.dumps(options), sort_order=len(sessions)))
    if case in {"TC-SHELL-B01", "TC-SHELL-B29", "TC-SHELL-B30", "TC-SHELL-B34", "TC-SHELL-B44"}:
        sessions = []
    count = 100 if case == "TC-SHELL-B39" else 30 if case == "TC-SHELL-B08" else 0
    if count:
        sessions = [dict(sessions[0], id=f"shell-{i:03}", name=f"qa-{i:03}", last_connected_at=2000-i) for i in range(count)]
    recents = [{"id": "shell-work", "name": "Shell 工作区", "roots": [{"id": "root-shell", "name": "preview", "path": "/preview", "kind": "folder"}], "looseFiles": [], "lastOpenedAt": 3000, "isGitRepo": False}]
    if not sessions:
        recents = []
    seed = {"taomni.qa.shell.enabled": "true", "taomni.codeWorkspace.toolWindowStripes.v1": '{"showNames":false,"leftWidth":59,"rightWidth":59}', "taomni.sessions.v1": json.dumps(sessions, ensure_ascii=False),
            "taomni.recentWorkspaces.v1": json.dumps(recents, ensure_ascii=False), "taomni.welcomeRecentSessionLimit": "100"}
    if case == "TC-SHELL-B48":
        seed["taomni.qa.shell.javaFixture"] = "true"
        recents[0]["lastActiveFile"] = {"kind": "root", "rootId": "root-shell", "path": "Main.java"}
        seed["taomni.recentWorkspaces.v1"] = json.dumps(recents, ensure_ascii=False)
    if case in {"TC-SHELL-B04", "TC-SHELL-B42"}:
        # This scenario restores only its two workspace descriptors. Saved
        # sessions remain available for the later explicit orphan-owner choice.
        seed["taomni.welcome.sessionResumeCleared.v1"] = "true"
    if case in {"TC-SHELL-B18", "TC-SHELL-B26"}:
        seed["taomni.qa.shell.transferControlled"] = "true"
    if case == "TC-SHELL-B26":
        seed["taomni.stub.notes.v1"] = json.dumps([dict(
            id=f"shell-note-{i:03}", title=f"SHELL-NOTE-{i:03}", body=f"Note {i} 中文 full body\nSecond paragraph",
            completed_at=None, pinned=False, archived_at=None, color=None, priority=0, due_at=1000,
            reminder_at=None, repeat_rule=None, source_tab_id=None, source_session_id=None,
            source_title=None, source_uri=None, created_at=1000, updated_at=1000, steps=[], tag_ids=[],
        ) for i in range(1, 102)], ensure_ascii=False)
        seed["taomni.taoAlerts.history.v1"] = json.dumps([dict(
            id=f"historical-{i}", title=f"SHELL-HISTORY-{i:03}", source="notes", kind="note_overdue",
            noteId=f"archived-note-{i}", fireAt=i, historyId=f"historical-{i}:{i}", firstSeenAt=i, lastSeenAt=i,
        ) for i in range(305)])
    code = """(seed => { if (sessionStorage.getItem('qa.shell.seed')) return; sessionStorage.setItem('qa.shell.seed','1');
      Object.entries(seed).forEach(([key,value])=>localStorage.setItem(key,value)); })(%s);""" % json.dumps(seed, ensure_ascii=False)
    ctx.page.context.add_init_script(code)
