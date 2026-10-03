"""Controlled external IPC faults. Never writes app stores or dispatches UI handlers."""
import json
from . import verb, StepError
COMMANDS = {"create_local_terminal", "create_ssh_terminal", "save_session", "sftp_attach", "workspace_list_dir", "workspace_write_file", "db_save_query_workspace", "open_detached_window", "get_welcome_run_snapshot"}


@verb("shell_backend_scenario")
def backend_scenario(ctx, args):
    if ctx.cfg.get("app", {}).get("mode") != "browser":
        raise StepError("shell_backend_scenario is a browser IPC boundary, not native evidence")
    if args["action"] not in ["fail-next", "hold", "release"] or args.get("command") not in COMMANDS and args["action"] != "release":
        raise StepError("Invalid controlled Shell scenario")
    if ctx.dry_run:
        return
    ctx.page.evaluate("rule => { if(rule.action === 'release') localStorage.removeItem('taomni.qa.shell.fault'); else localStorage.setItem('taomni.qa.shell.fault', JSON.stringify({mode:rule.action,command:rule.command,owner:rule.owner})); }", args)


@verb("assert_shell_backend")
def assert_backend(ctx, args):
    if ctx.dry_run:
        return
    rows = ctx.page.evaluate("JSON.parse(localStorage.getItem('taomni.qa.shell.observations') || '[]')")
    matched = [row for row in rows if row.get("command") == args["command"] and row.get("status") == args.get("status", "requested") and (not args.get("owner") or args["owner"] in row.get("owner", ""))]
    if len(matched) != args["count"]:
        raise StepError(f"Expected {args['count']} matching IPC observations, got {len(matched)}")
    (ctx.case_dir / f"shell-ipc-{ctx.step_index}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
