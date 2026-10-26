"""Switch only to real app-created windows whose DOM matches a case selector."""
import json
from .deadline import budget_time as time
from native_webdriver_transport import WebDriverError


def arguments(args):
    from .steps import StepError
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str) or not args["selector"]:
        raise StepError("switch_window requires a nonempty CSS selector")
    if "close_with" in args and (not isinstance(args["close_with"], str) or not args["close_with"]):
        raise StepError("switch_window close_with requires a nonempty CSS selector")
    return args["selector"], float(args.get("timeout_sec", 30))


def native_switch(ctx, args):
    from .steps import StepError
    selector, timeout = arguments(args)
    if getattr(ctx, "dry_run", False): return "validated window selector"
    end = time.monotonic() + timeout
    error = "no matching window"
    source = None
    if args.get("close_with"):
        source = ctx.session.request("GET", ctx.session.endpoint("/window"))
        try:
            # Dispatch once: reattach can destroy this WebView before WebKit
            # acknowledges the element click. Only its observed disappearance
            # permits recovery; never replay an uncertain action.
            ctx.session.click(args["close_with"])
        except WebDriverError as exc:
            # WKWebView can disappear before its evaluation callback replies.
            # A timeout is uncertain input, so never replay it; require the
            # same observed source-window closure as a no-such-window reply.
            if not any(message in str(exc) for message in (
                    "no such window", "WebView JavaScript evaluation timed out")):
                raise
    while time.monotonic() < end:
        handles = ctx.session.request("GET", ctx.session.endpoint("/window/handles"))
        if source is not None and source in handles:
            error = "source window did not close"
            time.sleep(.1)
            continue
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
    source = ctx.page if args.get("close_with") else None
    if source is not None:
        try:
            source.locator(args["close_with"]).first.click()
        except Exception:
            if not source.is_closed():
                raise
    while time.monotonic() < end:
        if source is not None and not source.is_closed():
            source.wait_for_timeout(100)
            continue
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
