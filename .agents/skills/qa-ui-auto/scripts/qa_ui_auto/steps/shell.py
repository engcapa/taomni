"""Controlled external IPC faults. Never writes app stores or dispatches UI handlers."""
import json
from . import verb, StepError
COMMANDS = {"create_local_terminal", "create_ssh_terminal", "save_session", "sftp_attach", "sftp_cancel_transfer", "workspace_list_dir", "workspace_write_file", "workspace_write_file_encoded", "workspace_write_loose_file_encoded", "db_save_query_workspace", "open_detached_window", "get_welcome_run_snapshot", "notes_list", "notes_get", "notes_update", "notes_list_alerts", "notes_ack_alert", "chat_list_threads", "chat_list_messages", "mail_list_cached_folders", "mail_list_cached_messages", "chat_stream", "test_proxy_connection"}


@verb("app_menu_action")
def menu_action(ctx, args):
    if args not in {"split", "multiexec", "exit"}:
        raise StepError("app_menu_action: expected split, multiexec or exit")
    if ctx.dry_run:
        return
    ctx.page.locator('[data-testid="app-main-menu"]').click()
    if args == "exit":
        ctx.page.locator('[data-testid="context-menu-item-exit"]').click()
        return
    view = ctx.page.locator('[data-testid="context-menu-item-view"]')
    view.wait_for(state="visible")
    view.hover()
    item = "split-terminal" if args == "split" else "multiexec"
    ctx.page.locator(f'[data-testid="context-menu-item-{item}"]').click()


@verb("shell_navigate")
def navigate(ctx, args):
    if args not in {"sessions", "tools"}:
        raise StepError("shell_navigate: expected sessions or tools")
    if ctx.dry_run:
        return
    area = "sessions" if args == "sessions" else "workspaces"
    target = '[data-testid="session-tree"]' if args == "sessions" else '[data-testid="shell-navigator-page"][data-page="tools"]'
    rail = ctx.page.locator(f'[data-testid="shell-rail-{area}"]')
    # Navigation can start before React mounts. Wait for the real control before
    # observing the page, otherwise a default-open navigator is toggled closed.
    rail.wait_for(state="visible")
    if not ctx.page.locator(target).first.is_visible():
        rail.click()
    ctx.page.locator(target).first.wait_for(state="visible")
    if args == "tools":
        ctx.page.locator(target).click()
        ctx.page.locator('[data-testid="sidebar-tools-panel"]').wait_for(state="visible")


@verb("shell_backend_scenario")
def backend_scenario(ctx, args):
    if ctx.cfg.get("app", {}).get("mode") != "browser":
        raise StepError("shell_backend_scenario is a browser IPC boundary, not native evidence")
    if args["action"] not in ["fail-next", "hold", "release"] or args.get("command") not in COMMANDS and args["action"] != "release":
        raise StepError("Invalid controlled Shell scenario")
    if ctx.dry_run:
        return
    ctx.page.evaluate("rule => { if(rule.action === 'release') localStorage.removeItem('taomni.qa.shell.fault'); else localStorage.setItem('taomni.qa.shell.fault', JSON.stringify({mode:rule.action,command:rule.command,owner:rule.owner,once:rule.once})); }", args)


@verb("assert_shell_backend")
def assert_backend(ctx, args):
    if ctx.dry_run:
        return
    ctx.page.wait_for_function("args => JSON.parse(localStorage.getItem('taomni.qa.shell.observations') || '[]').filter(row => row.command === args.command && row.status === (args.status || 'requested') && (!args.owner || row.owner.includes(args.owner))).length === args.count", arg=args, timeout=5000)
    rows = ctx.page.evaluate("JSON.parse(localStorage.getItem('taomni.qa.shell.observations') || '[]')")
    matched = [row for row in rows if row.get("command") == args["command"] and row.get("status") == args.get("status", "requested") and (not args.get("owner") or args["owner"] in row.get("owner", ""))]
    if len(matched) != args["count"]:
        raise StepError(f"Expected {args['count']} matching IPC observations, got {len(matched)}")
    (ctx.case_dir / f"shell-ipc-{ctx.step_index}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


@verb("shell_transfer_scenario")
def transfer_scenario(ctx, args):
    if ctx.cfg.get("app", {}).get("mode") != "browser":
        raise StepError("shell_transfer_scenario requires the browser SFTP service fixture")
    if args.get("action") not in {"advance", "complete", "fail", "replay"} or args.get("owner") not in {"alpha.invalid", "beta.invalid"}:
        raise StepError("Unknown transfer fixture action or owner")
    if ctx.dry_run:
        return
    if args["action"] == "replay":
        ctx.page.evaluate("owner => new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent('qa-shell-transfer-replay', {detail: {owner, resolve, reject}})))", args["owner"])
        return
    ctx.page.evaluate("control => { const key = 'taomni.qa.shell.transferControl'; const list = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify([...list, control])); }", args)
