"""Input-only saved-session/workspace catalogue for Shell renderer workflows."""
from __future__ import annotations
import json


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
    code = """(seed => { if (sessionStorage.getItem('qa.shell.seed')) return; sessionStorage.setItem('qa.shell.seed','1');
      Object.entries(seed).forEach(([key,value])=>localStorage.setItem(key,value)); })(%s);""" % json.dumps(seed, ensure_ascii=False)
    ctx.page.context.add_init_script(code)
