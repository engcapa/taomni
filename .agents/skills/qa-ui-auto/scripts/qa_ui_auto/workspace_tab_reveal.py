"""Reveal a clipped file tab through the same scroll arrows a user can use."""
import json
import time

from .steps import StepError

GEOMETRY = r"""
const target = document.querySelector(SELECTOR);
if (!target?.matches('[data-testid="workspace-tab"]')) return null;
const area = target.closest('[data-testid="workspace-tab-scroll-area"]');
if (!area) throw new Error('Workspace tab has no scroll area');
const r = target.getBoundingClientRect(), viewport = area.getBoundingClientRect();
const left = Math.max(0, viewport.left), right = Math.min(innerWidth, viewport.right);
const direction = r.left < left - 1 ? 'left' : r.right > right + 1 ? 'right' : null;
const button = direction ? '[data-testid="workspace-tab-scroll-' + direction + '"]' : null;
const control = button ? document.querySelector(button) : null;
const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
return {active: area.querySelector('[data-active="true"]')?.getAttribute('data-tab-id') ?? null,
  scrollLeft: area.scrollLeft, scrollWidth: area.scrollWidth, clientWidth: area.clientWidth,
  left: r.left, right: r.right, viewportLeft: left, viewportRight: right,
  visible: r.width > 0 && r.height > 0 && !direction && !!hit && target.contains(hit),
  button: control && !control.disabled ? button : null};
"""


def reveal(ctx, selector: str) -> list[dict]:
    native = hasattr(ctx, "session")
    script = GEOMETRY.replace("SELECTOR", json.dumps(selector), 1)
    read = (lambda: ctx.session.execute(script)) if native else lambda: ctx.page.evaluate("() => {" + script + "}")
    samples = []
    active = None
    for index in range(21):
        position = read()
        if position is None:
            return samples  # Tree/Home activations have no outer tab to reveal.
        if not isinstance(position, dict) or not isinstance(position.get("visible"), bool):
            raise StepError("Invalid workspace tab visibility observation")
        samples.append(position)
        if index == 0:
            active = position.get("active")
        elif position.get("active") != active:
            raise StepError("Scrolling workspace tabs changed the active document")
        if position["visible"]:
            return samples
        button = position.get("button")
        if not button or index == 20:
            raise StepError(f"Workspace file tab could not be revealed with its scroll arrows: {position}; samples={samples}")
        if native:
            ctx.session.click(button)
        else:
            ctx.page.locator(button).click()
        time.sleep(.025)
    raise AssertionError("unreachable")
