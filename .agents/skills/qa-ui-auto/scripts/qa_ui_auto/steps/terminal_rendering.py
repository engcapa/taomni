"""Controlled real-renderer fixture; deliberately not an eval_readonly write."""
from typing import Any

from . import StepContext, verb


@verb('terminal_rendering_probe')
def terminal_rendering_probe(ctx: StepContext, args: Any) -> None:
    if ctx.dry_run:
        return
    from ..terminal_rendering_probe import run_probe

    run_probe(ctx.case_dir, lambda expr: ctx.page.evaluate('() => (' + expr + ')'),
              lambda path: ctx.page.screenshot(path=str(path)), args)
