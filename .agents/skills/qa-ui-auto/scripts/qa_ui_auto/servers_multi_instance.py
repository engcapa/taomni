"""Browser and native multi-instance singleton verification for the Local servers tab."""
from __future__ import annotations

import copy
import json
import os
import platform
from collections.abc import Mapping
from contextlib import ExitStack, suppress
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .browser_evidence import BrowserEvidence
from .mail_multi_instance import free_ports
from .mail_performance import UI
from .runtime_errors import browser_assert, native_assert
from .steps import StepError

SERVERS_TAB = '[data-testid="tab-item"][data-tab-type="servers"]'
SERVERS_TAB_CLOSE = '[data-testid="tab-item"][data-tab-type="servers"] [data-testid="tab-close"]'
SERVERS_PANEL = '[data-testid="servers-tab-panel"]'
SERVERS_DIALOG = '[data-testid="servers-dialog"]'
SIDE_TAB_TOOLS = '[data-testid="side-tab-tools"]'
SIDEBAR_TOOL_SERVERS = '[data-testid="sidebar-tool-servers"]'
BLOCKED_DIALOG = '[data-testid="servers-blocked-dialog"]'
BLOCKED_MESSAGE = '[data-testid="servers-blocked-message"]'
BLOCKED_OK = '[data-testid="servers-blocked-ok"]'
WELCOME_PANEL = '[data-testid="welcome-panel"]'


def build_peer_shared_data_env(
    primary_env: Mapping[str, str],
    peer_root: Path,
    *,
    system: str | None = None,
) -> dict[str, str]:
    """Share the primary lock root while isolating the peer WebView directory."""
    resolved_system = system or platform.system()
    shared: dict[str, str] = {
        "TAOMNI_QA_WEBVIEW_DIR": str((peer_root / "native-webview").resolve()),
    }
    if resolved_system == "Linux":
        data_home = primary_env.get("XDG_DATA_HOME")
        if not data_home:
            raise StepError("servers_multi_instance_probe: primary XDG_DATA_HOME is missing")
        shared["XDG_DATA_HOME"] = data_home
    elif resolved_system == "Windows":
        data_dir = primary_env.get("NEWMOB_DATA_DIR")
        if not data_dir:
            raise StepError("servers_multi_instance_probe: primary NEWMOB_DATA_DIR is missing")
        shared["NEWMOB_DATA_DIR"] = data_dir
        appdata = primary_env.get("APPDATA")
        if appdata:
            shared["APPDATA"] = appdata
    elif resolved_system == "Darwin":
        data_dir = primary_env.get("NEWMOB_DATA_DIR")
        if not data_dir:
            raise StepError("servers_multi_instance_probe: primary NEWMOB_DATA_DIR is missing")
        shared["NEWMOB_DATA_DIR"] = data_dir
    else:
        raise StepError(f"servers_multi_instance_probe: unsupported platform {resolved_system}")
    return shared


def _validate_args(args: Any) -> None:
    if args is not None and (not isinstance(args, dict) or bool(args)):
        raise StepError("servers_multi_instance_probe: expected empty object {} or null")


def _count_js(selector: str) -> str:
    return f"document.querySelectorAll({json.dumps(selector)}).length"


def _require_zero(ui: UI, selector: str, message: str) -> None:
    count = int(ui.read(_count_js(selector)))
    if count != 0:
        raise StepError(f"{message} (observed {count} matches for {selector})")


def _require_one(ui: UI, selector: str, message: str) -> None:
    count = int(ui.read(_count_js(selector)))
    if count != 1:
        raise StepError(f"{message} (observed {count} matches for {selector})")


def _click_sidebar_servers_browser(page: Any) -> None:
    servers_btn = page.locator(SIDEBAR_TOOL_SERVERS)
    if not servers_btn.count() or not servers_btn.first.is_visible():
        page.locator(SIDE_TAB_TOOLS).click()
        servers_btn.wait_for(state="visible", timeout=10_000)
    servers_btn.click()


def _click_sidebar_servers_native(ui: UI) -> None:
    visible = bool(
        ui.read(
            f"(() => {{ const el = document.querySelector({json.dumps(SIDEBAR_TOOL_SERVERS)}); "
            "if (!el) return false; const r = el.getBoundingClientRect(); "
            "return r.width > 0 && r.height > 0; })()"
        )
    )
    if not visible:
        ui.act("click", SIDE_TAB_TOOLS)
        ui.act("wait_for", {"selector": SIDEBAR_TOOL_SERVERS, "timeout_sec": 10})
    ui.act("click", SIDEBAR_TOOL_SERVERS)


def _close_session_safe(session: Any) -> None:
    with suppress(Exception):
        session.close()


def _write_evidence(case_dir: Path, payload: dict[str, Any]) -> None:
    (case_dir / "servers-multi-instance.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )


def browser_run(ctx: Any, args: Any) -> str:
    """Verify cross-tab/cross-page Local servers singleton lock in browser mode."""
    _validate_args(args)
    if getattr(ctx, "dry_run", False):
        return "browser multi-page Local servers singleton verified (dry-run)"

    primary = ctx.page
    if primary.locator(SERVERS_TAB).count() != 1 or not primary.locator(SERVERS_DIALOG).first.is_visible():
        raise StepError("servers_multi_instance_probe: primary page must already have Local servers tab open")

    base_url = str((ctx.cfg.get("app") or {}).get("base_url") or "")
    if not base_url:
        raise StepError("servers_multi_instance_probe: app.base_url is required")

    peer_root = (ctx.case_dir / "peer").resolve()
    peer_root.mkdir(parents=True, exist_ok=True)
    peer = primary.context.new_page()
    peer_console: list[dict[str, Any]] = []
    evidence = BrowserEvidence(peer, peer_console, peer_root)
    blocked_message = ""

    try:
        peer.goto(base_url, wait_until="domcontentloaded", timeout=30_000)
        peer.locator(WELCOME_PANEL).wait_for(state="visible", timeout=30_000)

        _click_sidebar_servers_browser(peer)
        peer.locator(BLOCKED_DIALOG).wait_for(state="visible", timeout=10_000)
        blocked_message = (peer.locator(BLOCKED_MESSAGE).text_content() or "").strip()
        if not blocked_message:
            raise StepError("servers_multi_instance_probe: blocked dialog message was empty on peer page")
        if peer.locator(SERVERS_TAB).count() != 0 or peer.locator(SERVERS_DIALOG).count() != 0:
            raise StepError("servers_multi_instance_probe: blocked peer page opened a Local servers tab")

        peer.locator(BLOCKED_OK).click()
        peer.locator(BLOCKED_DIALOG).wait_for(state="detached", timeout=10_000)

        # Release the primary lease cleanly by closing its servers tab.
        primary.locator(SERVERS_TAB_CLOSE).click()
        primary.locator(SERVERS_DIALOG).wait_for(state="detached", timeout=10_000)
        if primary.locator(SERVERS_TAB).count() != 0:
            raise StepError("servers_multi_instance_probe: primary servers tab remained after closing")

        # Now peer can claim the lease and open its single Local servers tab.
        _click_sidebar_servers_browser(peer)
        peer.locator(SERVERS_DIALOG).wait_for(state="visible", timeout=10_000)
        if peer.locator(BLOCKED_DIALOG).count() != 0:
            raise StepError("servers_multi_instance_probe: peer page showed blocked dialog after primary release")
        if peer.locator(SERVERS_TAB).count() != 1 or peer.locator(SERVERS_PANEL).count() != 1:
            raise StepError("servers_multi_instance_probe: peer page did not open a single Local servers tab")

        browser_assert(
            SimpleNamespace(
                page=peer,
                case_state={"runtime_console": peer_console},
                case_dir=peer_root,
                dry_run=False,
            ),
            None,
        )
        evidence.close()

        # Closing peer while holding the lock must fire unload cleanup so primary can reclaim.
        peer.close(run_before_unload=True)
    finally:
        with suppress(Exception):
            evidence.close()
        if not peer.is_closed():
            with suppress(Exception):
                peer.close(run_before_unload=True)

    _click_sidebar_servers_browser(primary)
    primary.locator(SERVERS_DIALOG).wait_for(state="visible", timeout=10_000)
    if primary.locator(BLOCKED_DIALOG).count() != 0:
        raise StepError("servers_multi_instance_probe: primary page was blocked after peer unload")
    if primary.locator(SERVERS_TAB).count() != 1:
        raise StepError("servers_multi_instance_probe: primary page did not reclaim single Local servers tab")

    _write_evidence(
        ctx.case_dir,
        {
            "mode": "browser",
            "blockedMessage": blocked_message,
            "assertions": [
                "peer page blocked while primary held Local servers tab",
                "peer page acquired Local servers tab after primary closed tab",
                "primary page reclaimed Local servers tab after peer closed while holding lock",
            ],
        },
    )
    return "browser two-page Local servers singleton verified"


def native_run(ctx: Any, args: Any) -> str:
    """Verify two-process OS ModuleLock Local servers singleton behavior in native mode."""
    from tauri_webdriver import NativeHarness
    from .native_steps import NativeStepContext

    _validate_args(args)
    if getattr(ctx, "dry_run", False):
        return "native two-process Local servers singleton verified (dry-run)"

    primary = UI(ctx)
    primary.act("wait_for", {"selector": SERVERS_DIALOG, "timeout_sec": 20})
    _require_one(primary, SERVERS_TAB, "primary window must already have Local servers tab open")

    peer_root = (ctx.case_dir / "peer").resolve()
    peer_root.mkdir(parents=True, exist_ok=True)
    shared_env = build_peer_shared_data_env(os.environ, peer_root)
    Path(shared_env["TAOMNI_QA_WEBVIEW_DIR"]).mkdir(parents=True, exist_ok=True)

    cfg = copy.deepcopy(ctx.cfg)
    port, native_port = free_ports()
    cfg.setdefault("webdriver", {}).update(port=port, native_port=native_port)
    blocked_message = ""

    with NativeHarness(cfg, peer_root, shared_data_env=shared_env) as harness, ExitStack() as cleanup:
        peer_session = harness.create_session()
        cleanup.callback(lambda: _close_session_safe(peer_session))
        peer_ctx = NativeStepContext(peer_session, peer_root, cfg)
        peer = UI(peer_ctx)

        peer.act("wait_for", {"selector": WELCOME_PANEL, "timeout_sec": 60})
        _click_sidebar_servers_native(peer)
        peer.act("wait_for", {"selector": BLOCKED_DIALOG, "timeout_sec": 20})

        blocked_message = (peer_session.text(BLOCKED_MESSAGE) or "").strip()
        if not blocked_message:
            raise StepError("servers_multi_instance_probe: blocked dialog message was empty in peer process")
        _require_zero(peer, SERVERS_TAB, "blocked peer process opened a Local servers tab")
        _require_zero(peer, SERVERS_DIALOG, "blocked peer process rendered servers-dialog")
        native_assert(peer_ctx, None)

        peer.act("click", BLOCKED_OK)
        peer.until(f"{_count_js(BLOCKED_DIALOG)} === 0", 10)

        # Closing primary's Local servers tab must release the OS lock for the peer process.
        primary.act("click", SERVERS_TAB_CLOSE)
        primary.until(f"{_count_js(SERVERS_TAB)} === 0 && {_count_js(SERVERS_DIALOG)} === 0", 10)

        peer.act("click", SIDEBAR_TOOL_SERVERS)
        peer.act("wait_for", {"selector": SERVERS_DIALOG, "timeout_sec": 20})
        _require_zero(peer, BLOCKED_DIALOG, "peer process remained blocked after primary closed tab")
        _require_one(peer, SERVERS_TAB, "peer process did not open exactly one Local servers tab")
        _require_one(peer, SERVERS_PANEL, "peer process did not render servers-tab-panel")
        native_assert(peer_ctx, None)
        # Exit NativeHarness while peer still holds the lock so the OS closes the handle on exit.

    _click_sidebar_servers_native(primary)
    primary.act("wait_for", {"selector": SERVERS_DIALOG, "timeout_sec": 20})
    _require_zero(primary, BLOCKED_DIALOG, "primary remained blocked after peer process terminated")
    _require_one(primary, SERVERS_TAB, "primary did not reopen exactly one Local servers tab")

    _write_evidence(
        ctx.case_dir,
        {
            "mode": "native",
            "platform": platform.system(),
            "blockedMessage": blocked_message,
            "assertions": [
                "peer process blocked with servers-blocked-dialog while primary held ModuleLock",
                "peer process acquired Local servers tab after primary closed its tab",
                "primary process reclaimed Local servers tab after peer process terminated while holding lock",
            ],
        },
    )
    return f"native two-process Local servers singleton verified ({platform.system()})"
