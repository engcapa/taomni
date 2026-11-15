"""Idempotently show the real active Explorer preview through its toolbar only."""
from __future__ import annotations

import json
from .deadline import budget_time as time
from .steps import StepError

ROOT = '[data-testid="explorer-tab"][data-active="true"]'
BUTTON = ROOT + ' [data-testid="explorer-cmd-preview"]'
STATE = """(() => {
 const roots=Array.from(document.querySelectorAll('[data-testid="explorer-tab"][data-active="true"]')).filter(el=>el.getClientRects().length && getComputedStyle(el).visibility==='visible');
 if(roots.length!==1)return {active:roots.length,visible:false};
 const preview=roots[0].querySelector('[data-testid="explorer-preview"]');
 return {active:1,visible:!!preview && preview.getClientRects().length>0 && getComputedStyle(preview).visibility==='visible'};
})()"""


def run(ctx, args, mode):
    if args is not None:
        raise StepError("show_explorer_preview: expected null")
    if getattr(ctx, "dry_run", False):
        return "dry-run; no Explorer toolbar action"
    def observe():
        return ctx.session.execute("return " + STATE) if mode == "native" else ctx.page.evaluate(STATE)
    record = {"mode": mode, "clickCount": 0, "passed": False}
    try:
        before = observe();record["before"] = before
        if not isinstance(before, dict) or before.get("active") != 1:
            raise StepError("show_explorer_preview: no unique visible active Explorer")
        if not before.get("visible"):
            # Exactly one trusted user action; do not retry uncertain input or
            # edit settings/store to manufacture the expected responsive state.
            record["clickCount"] = 1
            if mode == "native":ctx.session.click(BUTTON)
            else:ctx.page.locator(BUTTON).click()
        deadline = time.monotonic() + 15
        while True:
            after = observe();record["after"] = after
            if isinstance(after, dict) and after.get("active") == 1 and after.get("visible"):
                break
            if time.monotonic() >= deadline:
                raise StepError("show_explorer_preview: toolbar did not show the actual preview")
            time.sleep(.1)
        record["passed"] = True
        return "Active Explorer preview visible after " + str(record["clickCount"]) + " toolbar clicks"
    except Exception as error:
        record["error"] = str(error);raise
    finally:
        with (ctx.case_dir / "explorer-preview-visibility.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")


def native(ctx,args):return run(ctx,args,"native")
def browser(ctx,args):return run(ctx,args,"browser")
