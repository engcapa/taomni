"""Switch only to real app-created windows whose DOM matches a case selector."""
import json
from .deadline import budget_time as time


def arguments(args):
    from .steps import StepError
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str) or not args["selector"]:
        raise StepError("switch_window requires a nonempty CSS selector")
    return args["selector"], float(args.get("timeout_sec", 30))


def native_switch(ctx, args):
    from .steps import StepError
    selector, timeout = arguments(args)
    if getattr(ctx, "dry_run", False): return "validated window selector"
    end = time.monotonic() + timeout
    error = "no matching window"
    while time.monotonic() < end:
        handles = ctx.session.request("GET", ctx.session.endpoint("/window/handles"))
        for handle in handles:
            try:
                ctx.session.request("POST", ctx.session.endpoint("/window"), {"handle": handle})
                if ctx.session.execute(f"return !!document.querySelector({json.dumps(selector)});"):
                    ctx.session.install_console_hook()
                    return f"selected real WebView window {handle} with {selector}"
            except Exception as exc:
                error = str(exc)
        time.sleep(.1)
    raise StepError(f"No real window matches {selector}: {error}")


def browser_switch(ctx, args):
    from .steps import StepError
    selector, timeout = arguments(args)
    if getattr(ctx, "dry_run", False): return
    context = ctx.page.context
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        for page in context.pages:
            if page.is_closed(): continue
            if page.locator(selector).count():
                page.bring_to_front()
                ctx.page = page
                return
        # Playwright's event loop must receive popup creation/navigation events.
        pages = [page for page in context.pages if not page.is_closed()]
        if not pages: raise StepError("All app windows closed")
        pages[0].wait_for_timeout(100)
    raise StepError(f"No real popup matches {selector}")
