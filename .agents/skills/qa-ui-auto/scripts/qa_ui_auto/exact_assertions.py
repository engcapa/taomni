"""Identical, read-only exact DOM observations in Chromium and native WebViews."""
from __future__ import annotations

import json
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError


def assert_exact(read: Callable[[str], Any], args: dict, *, items: bool) -> str:
    selector = args["selector"]
    expected = args["equals"]
    # JSON encoding is JavaScript literal encoding, never shell interpolation.
    attribute = args.get("attribute")
    value = f"e.getAttribute({json.dumps(attribute)})" if attribute else "e.textContent"
    expression = (
        f"Array.from(document.querySelectorAll({json.dumps(selector)}), e => {value})"
    )
    expires = time.monotonic() + float(args.get("timeout_sec", 10))
    last: Any = None
    while time.monotonic() < expires:
        last = read(expression)
        # Exact text requires one element: an absent empty string or an arbitrary
        # first match must not conceal a missing/duplicated result surface.
        if last == (expected if items else [expected]):
            return f"exact {'items' if items else 'text'} matched: {selector}"
        time.sleep(0.1)
    raise StepError(f"{selector}: expected exact {expected!r}; observed matches {last!r}")
