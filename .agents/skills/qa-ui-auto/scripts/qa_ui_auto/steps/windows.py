"""Switch among real renderer windows without creating destination state."""
from __future__ import annotations
import time
from . import StepError, verb
from ..window_routes import matches_window_route


@verb("switch_window")
def switch_window(ctx, args):
    if ctx.dry_run:
        return
    deadline = time.monotonic() + args.get("timeout_sec", 10)
    while time.monotonic() < deadline:
        for page in ctx.page.context.pages:
            if not page.is_closed() and matches_window_route(page.url, args["route"]):
                ctx.page = page
                page.bring_to_front()
                return
        # Sync Playwright delivers popup/navigation events while its API runs.
        # A Python sleep leaves context.pages stale for a newly opened child.
        ctx.page.wait_for_timeout(100)
    raise StepError(f"switch_window: no window matches route {args['route']!r}")


@verb("close_window")
def close_window(ctx, args):
    if not ctx.dry_run:
        ctx.page.close(run_before_unload=True)


@verb("click_window_close")
def click_window_close(ctx, args):
    """Click an expected self-closing control and require its real close event."""
    if ctx.dry_run:
        return
    from playwright.sync_api import Error
    page = ctx.page
    with page.expect_event("close", timeout=10000):
        try:
            page.locator(args).first.click()
        except Error:
            if not page.is_closed():
                raise
