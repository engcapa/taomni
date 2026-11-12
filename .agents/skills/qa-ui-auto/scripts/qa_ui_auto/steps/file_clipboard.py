"""Browser fixture clipboard only; no import action or OS clipboard access."""
from typing import Any

from . import StepContext, verb


@verb("file_clipboard")
def step_file_clipboard(ctx: StepContext, args: Any) -> None:
    from ..file_clipboard import browser
    browser(ctx, args)
