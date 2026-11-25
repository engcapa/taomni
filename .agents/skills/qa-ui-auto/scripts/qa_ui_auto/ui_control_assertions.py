"""Read the active document's real controls through either rendering engine."""
from __future__ import annotations

import json
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError


def observe(verb: str, args: Any, evaluate: Callable[[str], Any]) -> str:
    selector = args if isinstance(args, str) else args["selector"]
    if verb == "assert_computed_style":
        value = f"getComputedStyle(element).getPropertyValue({json.dumps(args['property'])}).trim()"
        expected = args["equals"]
    else:
        value = ("element.contains(document.activeElement)" if verb == "assert_focus_within"
                 else "element === document.activeElement")
        expected = True
    expression = f"""(() => {{
      const matches = document.querySelectorAll({json.dumps(selector)});
      const element = matches[0];
      return {{ count: matches.length, value: element ? {value} : null }};
    }})()"""
    deadline = time.monotonic() + 5
    while True:
        actual = evaluate(expression)
        if actual == {"count": 1, "value": expected}:
            return f"{verb} {selector}: {actual['value']}"
        if time.monotonic() >= deadline:
            raise StepError(f"{verb} {selector}: expected one match with {expected!r}, observed {actual!r}")
        time.sleep(0.1)


def browser(verb):
    def run(ctx, args):
        if not ctx.dry_run:
            return observe(verb, args, lambda expression: ctx.page.evaluate(f"() => ({expression})"))
    return run


def native(verb):
    def run(ctx, args):
        return observe(verb, args, lambda expression: ctx.session.execute(f"return ({expression});"))
    return run


VERBS = ("assert_focus_on", "assert_focus_within", "assert_computed_style")
