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
        time.sleep(.1)
    raise StepError(f"switch_window: no window matches route {args['route']!r}")


@verb("close_window")
def close_window(ctx, args):
    if not ctx.dry_run:
        ctx.page.close(run_before_unload=True)
