"""Browser entry for the shared passive file activation observer."""
from typing import Any

from . import StepContext, verb


@verb("measure_workspace_file_open")
def measure(ctx: StepContext, args: Any) -> None:
    from ..file_open_probe import run, validate
    validate(args)
    if not ctx.dry_run:
        run(ctx, args)


@verb("reveal_project_tree_row")
def reveal_tree(ctx: StepContext, args: Any) -> None:
    from ..project_tree_reveal import run, validate
    validate(args)
    if not ctx.dry_run:
        run(ctx, args)
