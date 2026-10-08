"""Navigation, waiting, and screenshots."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import StepContext, StepError, verb


def _coerce_seconds(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("ms"):
            return float(s[:-2]) / 1000.0
        if s.endswith("s"):
            s = s[:-1]
        return float(s)
    raise StepError(f"wait/sleep arg must be a number of seconds, got {value!r}")


@verb("open")
def step_open(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        url = args["url"]
    else:
        url = str(args)
    if ctx.dry_run:
        return
    # Retry only startup network failures, before any testcase interaction.
    # Dynamic imports can fail after DOMContentLoaded with a successful HTTP
    # navigation, so observe script failures until the app root mounts too.
    transient = ("ERR_NO_BUFFER_SPACE", "ERR_NETWORK_CHANGED")
    failures: list[str] = []

    def request_failed(request):
        if request.resource_type in {"document", "script"}:
            error = request.failure or ""
            if any(code in error for code in transient):
                failures.append(error)

    ctx.page.on("requestfailed", request_failed)
    try:
        for attempt in range(3):
            failures.clear()
            try:
                ctx.page.goto(url, wait_until="domcontentloaded")
                try:
                    ctx.page.wait_for_selector("#root > *", state="attached", timeout=30_000)
                except Exception:
                    # Standalone HTML design/prototype pages intentionally do
                    # not mount the React root. Keep the product startup gate
                    # strict while allowing those documented static routes to
                    # prove their own selectors in the following steps.
                    if not urlparse(url).path.lower().endswith(".html"):
                        raise
                    ctx.page.wait_for_selector("body > *", state="attached", timeout=30_000)
                if not failures:
                    return
                raise StepError("startup network failure: " + ", ".join(sorted(set(failures))))
            except Exception as exc:  # noqa: BLE001
                if not failures and not any(code in str(exc) for code in transient):
                    raise
                if attempt == 2:
                    raise
                # Retain recovered infrastructure faults in the case artifact.
                with (ctx.case_dir / "startup-network-retries.log").open("a", encoding="utf-8") as log:
                    log.write(f"attempt {attempt + 1}: {exc}\n")
                ctx.page.wait_for_timeout(250 * (attempt + 1))
    finally:
        ctx.page.remove_listener("requestfailed", request_failed)


@verb("goto")
def step_goto(ctx: StepContext, args: Any) -> None:
    step_open(ctx, args)


@verb("open_route")
def step_open_route(ctx: StepContext, args: Any) -> None:
    """Open an app route (``?servers=main``) relative to ``app.base_url``.

    The native runner implements the same verb as a same-origin navigation of
    the packaged main WebView, so one case can address the route in both modes.
    """
    route = args.get("route") if isinstance(args, dict) else args
    if not isinstance(route, str) or not route.startswith(("?", "/", "#")):
        raise StepError("open_route: expected a route starting with ?, / or #")
    base = str((ctx.cfg.get("app") or {}).get("base_url") or "").rstrip("/")
    if not base:
        raise StepError("open_route: app.base_url is not configured")
    step_open(ctx, base + (route if route.startswith("/") else "/" + route))


@verb("wait")
def step_wait(ctx: StepContext, args: Any) -> None:
    seconds = _coerce_seconds(args)
    if ctx.dry_run:
        return
    ctx.page.wait_for_timeout(int(seconds * 1000))  # type: ignore[attr-defined]


@verb("wait_for")
def step_wait_for(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        selector = args["selector"]
        timeout = float(args.get("timeout_sec", 30)) * 1000.0
        state = args.get("state", "visible")
    else:
        selector = str(args)
        timeout = 30_000.0
        state = "visible"
    if ctx.dry_run:
        ctx.page.locator(selector)  # noqa: B018  syntax check only
        return
    ctx.page.wait_for_selector(selector, timeout=timeout, state=state)


@verb("screenshot")
def step_screenshot(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        path = args["path"]
        selector = args.get("selector")
        full_page = bool(args.get("full_page", False))
    else:
        path = str(args)
        selector = None
        full_page = False
    target = ctx.case_dir / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if ctx.dry_run:
        target.write_bytes(b"")
        return
    if selector:
        loc = ctx.page.locator(selector)
        loc.first.screenshot(path=str(target))  # type: ignore[attr-defined]
    else:
        ctx.page.screenshot(path=str(target), full_page=full_page)


@verb("set_viewport")
def step_set_viewport(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict) or set(args) != {"width", "height"}:
        raise StepError("set_viewport: expected {width, height}")
    if ctx.dry_run:
        return
    if not hasattr(ctx.page, "set_viewport_size"):
        raise StepError("set_viewport: this runner does not support viewport changes")
    ctx.page.set_viewport_size(args)  # type: ignore[attr-defined]
