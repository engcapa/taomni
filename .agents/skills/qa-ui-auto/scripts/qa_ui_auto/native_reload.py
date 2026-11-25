"""Wait for a new native document, rather than accepting the previous shell."""
from __future__ import annotations

import json
import urllib.error

from tauri_webdriver import WebDriverError

from .deadline import budget_time as time
from .steps import StepError


def reload_window(ctx, timeout_sec=60, ready_selector='[data-testid="welcome-panel"]'):
    session = ctx.session
    session.execute(
        "window.__QA_UI_AUTO_RELOAD_PENDING__ = true;"
        "window.setTimeout(() => window.location.reload(), 0); return true;"
    )
    end = time.monotonic() + timeout_sec
    last_error = "previous document is still present"
    while time.monotonic() < end:
        try:
            ready = session.execute(
                "return window.__QA_UI_AUTO_RELOAD_PENDING__ !== true && "
                "document.readyState === 'complete' && "
                f"!!document.querySelector({json.dumps(ready_selector)});"
            )
        except (WebDriverError, urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last_error = str(error)
        else:
            if ready is True:
                session.activate_linux_window()
                session.install_console_hook()
                return f"reloaded; new document contains {ready_selector}"
        time.sleep(max(0.0, min(0.1, end - time.monotonic())))
    raise StepError(f"reload_window: new document did not mount within {timeout_sec}s: {last_error}")
