"""Retain a Chromium CPU sample for file-open diagnosis, separate from its oracle."""
from contextlib import contextmanager
import json
from pathlib import Path


@contextmanager
def capture(page, target: Path):
    session = None
    report = {"available": False, "profile": None}
    try:
        browser = page.context.browser
        if browser is not None and browser.browser_type.name == "chromium":
            session = page.context.new_cdp_session(page)
            session.send("Profiler.enable")
            session.send("Profiler.setSamplingInterval", {"interval": 1000})
            session.send("Profiler.start")
            report["available"] = True
        else:
            report["reason"] = "Chromium CDP sampling is unavailable on this browser"
    except Exception as error:
        report["error"] = str(error)
    failed = False
    try:
        yield
    except BaseException:
        failed = True
        raise
    finally:
        if session is not None:
            try:
                report["profile"] = session.send("Profiler.stop").get("profile")
            except Exception as error:
                report["error"] = str(error)
            finally:
                try:
                    session.detach()
                except Exception as error:
                    report["detachError"] = str(error)
        try:
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        except Exception:
            if not failed:
                raise
