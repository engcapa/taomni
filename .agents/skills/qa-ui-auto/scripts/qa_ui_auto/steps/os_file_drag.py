"""Register the shared synthetic file-drag entry without import cycles."""
from typing import Any

from . import StepContext, verb


@verb("os_file_drag")
def step_os_file_drag(ctx: StepContext, args: Any) -> None:
    from ..os_file_drag import browser
    browser(ctx, args)


@verb("assert_workspace_drop_import")
def step_assert_workspace_drop_import(ctx: StepContext, args: Any) -> None:
    from ..workspace_drop_observation import run
    run(ctx, args, mode="browser")


@verb("assert_explorer_files")
def step_assert_explorer_files(ctx: StepContext, args: Any) -> None:
    from ..explorer_observation import run
    run(ctx, args, mode="browser")
