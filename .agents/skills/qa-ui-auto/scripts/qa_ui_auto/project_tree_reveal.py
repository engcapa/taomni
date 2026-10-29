"""Scroll the real explorer viewport to a lazily mounted row; never activate it."""
import hashlib
import json
import math
import re
import time

from .steps import StepError

TREE_ROW = re.compile(r'''data-testid\s*=\s*['"]code-workspace-(?:tree-(?:dir|file|loose-file)|flat-file)['"]''')
GEOMETRY = r"""
const tree=document.querySelector('[data-testid="code-workspace-tree"]');
if(!tree)return null;
const target=tree.querySelector(SELECTOR);
const viewport=tree.getBoundingClientRect();
const rect=target?.getBoundingClientRect();
return {found:!!target,visible:!!rect && rect.width>0 && rect.height>0 && rect.top>=viewport.top && rect.bottom<=viewport.bottom,
  virtual:!!tree.querySelector('[data-testid="code-workspace-tree-viewport"]'),
  offset:tree.scrollTop,height:tree.clientHeight,total:tree.scrollHeight,
  targetTop:rect?.top ?? null,targetBottom:rect?.bottom ?? null,viewportTop:viewport.top,viewportBottom:viewport.bottom};
"""


def validate(selector):
    if not isinstance(selector, str) or not TREE_ROW.search(selector):
        raise StepError("reveal_project_tree_row expects an explorer row selector")
    return selector


def reveal(ctx, selector):
    if not isinstance(selector, str) or not TREE_ROW.search(selector):
        return []  # File-tab and Home-card activations have no tree to scroll.
    native = hasattr(ctx, "session")
    execute = ctx.session.execute if native else lambda script: ctx.page.evaluate("() => {" + script + "}")
    script = GEOMETRY.replace("SELECTOR", json.dumps(selector), 1)
    samples = []
    restarted = False
    deadline = time.monotonic() + 20
    try:
        for _ in range(240):
            value = execute(script)
            if value is None:
                if samples:
                    raise StepError("Explorer disappeared while revealing its row")
                return samples
            if (not isinstance(value, dict) or type(value.get("visible")) is not bool
                    or any(type(value.get(key)) not in {int, float} or not math.isfinite(value[key]) or value[key] < 0
                           for key in ["offset", "height", "total"])):
                raise StepError("Invalid project tree visibility observation")
            if not value.get("virtual") and not value.get("found"):
                if samples:
                    raise StepError("Explorer row disappeared while scrolling")
                return []
            samples.append(value)
            if value["visible"]:
                return samples
            if time.monotonic() >= deadline or value["height"] <= 0:
                break
            if value["found"]:
                execute("document.querySelector(" + json.dumps(selector) + ")?.scrollIntoView({block:'nearest',inline:'nearest'}); return true;")
            else:
                offset = 0 if not restarted else min(value["total"] - value["height"], value["offset"] + value["height"] * .7)
                if restarted and len(samples) > 2 and all(abs(sample["offset"] - offset) < 1 for sample in samples[-2:]):
                    break
                restarted = True
                execute("document.querySelector('[data-testid=\"code-workspace-tree\"]').scrollTo({top:" + json.dumps(offset) + ",behavior:'instant'}); return true;")
            time.sleep(.025)
        raise StepError("Explorer row could not be revealed by scrolling its viewport")
    finally:
        if samples:
            label = hashlib.sha256(selector.encode()).hexdigest()[:12]
            (ctx.case_dir / ("tree-reveal-" + label + ".json")).write_text(json.dumps(samples, indent=2) + "\n")


def run(ctx, args):
    validate(args)
    if not reveal(ctx, args):
        raise StepError("Explorer row is missing from the current tree")
    return "Explorer row revealed by scrolling without changing selection or opening a file"
