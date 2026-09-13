"""DOM assertions shared by native cases, without app-state mutation."""

from typing import Any

from .deadline import budget_time as time
from .steps import StepError


def assert_count(ctx: Any, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or not {"min", "max", "equal"} & args.keys():
        raise StepError("assert_count: expected {selector, min/max/equal}")
    count = ctx.session.count(str(args["selector"]))
    for bound, compare in (("equal", lambda n: count == n),
                           ("min", lambda n: count >= n),
                           ("max", lambda n: count <= n)):
        if bound in args and not compare(int(args[bound])):
            raise StepError(f"assert_count: {args['selector']}: expected {bound}={args[bound]}, got {count}")
    return f"count ok: {args['selector']} = {count}"


def assert_menu_items(ctx: Any, args: Any) -> str:
    if not isinstance(args, list) or not args or not all(isinstance(label, str) for label in args):
        raise StepError("assert_menu_items: expected nonempty list of labels")
    deadline = time.time() + 10
    missing = args
    while time.time() < deadline:
        # innerText excludes hidden descendants; check visible nodes within the
        # menu so an identically named editor tab cannot satisfy this assertion.
        labels = ctx.session.execute("""
            return Array.from(document.querySelectorAll('[data-testid="context-menu"] *'))
              .filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible')
              .map(el => el.innerText || '');
        """)
        missing = [label for label in args if not any(label in text for text in labels)]
        if not missing:
            return f"menu items visible: {args!r}"
        time.sleep(0.2)
    raise StepError(f"context menu missing visible items: {missing!r}")
