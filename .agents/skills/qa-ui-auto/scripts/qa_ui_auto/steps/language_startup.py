"""Entry-level assertions at the unchanged browser language invoke boundary."""
from typing import Any

from . import StepContext, StepError, verb


@verb("observe_language_startup")
def observe(ctx: StepContext, args: Any) -> None:
    if args is not None:
        raise StepError("observe_language_startup does not accept arguments")
    if not ctx.dry_run:
        from ..language_startup_observer import install_browser
        install_browser(ctx)


@verb("assert_language_startup")
def assert_counts(ctx: StepContext, args: Any) -> None:
    from ..language_startup_observer import assert_browser, validate_expectations
    validate_expectations(args)
    if not ctx.dry_run:
        assert_browser(ctx, args)
