"""Real AppKit menu state and actions; never mutate renderer command state."""
import json

from .deadline import budget_time as time
from .steps import StepError


def native_menu(ctx, args):
    path = args.get("path") if isinstance(args, dict) else None
    action = args.get("action") if isinstance(args, dict) else None
    if (not isinstance(args, dict) or ("path" in args) == ("action" in args)
            or set(args) - {"path", "action", "enabled", "checked", "activate"}
            or ("path" in args and (not isinstance(path, list) or not 1 <= len(path) <= 8
                or any(type(index) is not int or index < 0 for index in path)))
            or ("action" in args and (not isinstance(action, str) or not action))
            or any(type(args[key]) is not bool for key in ("enabled", "checked", "activate") if key in args)
            or not {"enabled", "checked"} & set(args)
            or (args.get("activate") and args.get("enabled") is not True)):
        raise StepError("native_menu expects {path: [indices] | action: id, enabled?: boolean, checked?: boolean, activate?: boolean}")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if ctx.session.execute("return window.__TAOMNI_QA_APP_MENU__?.ready() === true;") is not True:
            time.sleep(.05)
            continue
        if action:
            path = ctx.session.execute("return window.__TAOMNI_QA_APP_MENU__?.path(" + json.dumps(action) + ") ?? null;")
            if (not isinstance(path, list) or not 1 <= len(path) <= 8
                    or any(type(index) is not int or index < 0 for index in path)):
                time.sleep(.05)
                continue
        observed = ctx.session.request("POST", ctx.session.endpoint("/qa/application-menu"), {"path": path})
        with (ctx.case_dir / "native-menu-observations.jsonl").open("a", encoding="utf-8") as trace:
            trace.write(json.dumps(observed) + "\n")
        if not isinstance(observed, dict) or observed.get("path") != path or observed.get("transport") != "AppKit NSMenu":
            raise StepError("Native menu response is not a matching AppKit observation")
        if any(observed.get(key) is not args[key] for key in ("enabled", "checked") if key in args):
            time.sleep(.05)
            continue
        if args.get("activate"):
            # A delivered activation must never be retried. The Rust endpoint
            # verifies the actual leaf is still enabled before dispatching.
            activated = ctx.session.request("POST", ctx.session.endpoint("/qa/application-menu"),
                                            {"path": path, "activate": True})
            with (ctx.case_dir / "native-menu-observations.jsonl").open("a", encoding="utf-8") as trace:
                trace.write(json.dumps(activated) + "\n")
            if (not isinstance(activated, dict) or activated.get("activated") is not True
                    or activated.get("path") != path or activated.get("transport") != "AppKit NSMenu"):
                raise StepError("Native menu activation was not acknowledged")
        return json.dumps(observed)
    raise StepError("Actual native menu did not reach the expected state")
