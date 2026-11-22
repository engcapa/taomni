"""Record the isolated writer lease across signed SocksCap parser calls."""

import json

from .fixtures.backup_policy import isolated_data_root
from .module_profile_observation import writer_lease
from .steps import StepError


def show_upstream(ctx, args, *, mode):
    if args is not None:
        raise StepError("show_sockscap_upstream: expected null")
    if getattr(ctx, "dry_run", False):
        return "dry-run; no SocksCap toggle action"
    selector = '[data-testid="sockscap-section-upstream-toggle"]'
    if mode == "native":
        expanded = ctx.session.execute(
            f"return document.querySelector({json.dumps(selector)})?.getAttribute('aria-expanded');",
        )
        if expanded == "false":
            ctx.session.click(selector)
    else:
        button = ctx.page.locator(selector)
        expanded = button.get_attribute("aria-expanded")
        if expanded == "false":
            button.click()
    if expanded not in {"false", "true"}:
        raise StepError("SocksCap upstream settings are unavailable")
    return "SocksCap upstream settings are open"


def run(ctx, phase):
    owner = ctx.fixture_context
    receipt = getattr(owner, "signed_sockscap", None)
    if owner.case_id != "TC-MODULES-072" or not receipt or phase not in {"idle", "running", "disabled"}:
        raise StepError("The SocksCap host observation requires its signed native case")
    observed = writer_lease(isolated_data_root(owner) / "plugins", slug="sockscap", enabled=phase == "running")
    result = {
        "phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
        "packageSha256": receipt["sha256"], "hostSha256": receipt["hostSha256"], "writerLease": observed,
    }
    (ctx.case_dir / f"signed-sockscap-{phase}.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8",
    )
    return f"SocksCap host writer lease verified ({phase})"
