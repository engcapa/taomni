"""Measure rendered sRGB text contrast on a solid opaque control surface."""

import json
import re
from pathlib import Path

from .steps import StepError


def luminance(color: str) -> float:
    match = re.fullmatch(r"rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)", color)
    if not match:
        raise StepError(f"Expected an opaque computed sRGB color, observed {color}")
    channels = [int(value) / 255 for value in match.groups()]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def run_contrast(args: dict, evaluate, case_dir: Path) -> str:
    selector = json.dumps(args["selector"])
    values = evaluate(f"""Array.from(document.querySelectorAll({selector}), element => {{
      const style = getComputedStyle(element);
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return {{foreground: style.color, background: style.backgroundColor, image: style.backgroundImage,
        opacity, visible: element.getBoundingClientRect().height > 0 && style.visibility === 'visible'}};
    }})""")
    if not values:
        raise StepError(f"No elements matched {selector}")
    for sample in values:
        if not sample["visible"] or sample["opacity"] != 1 or sample["image"] != "none":
            raise StepError(f"Expected a visible opaque solid surface for {selector}: {sample}")
        low, high = sorted(luminance(sample[key]) for key in ("foreground", "background"))
        sample["ratio"] = (high + 0.05) / (low + 0.05)
    with (case_dir / "contrast.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"selector": args["selector"], "samples": values}) + "\n")
    observed = min(item["ratio"] for item in values)
    if observed < args["minimum"]:
        raise StepError(f"{selector} contrast {observed:.2f} below {args['minimum']}")
    return f"{selector} minimum measured contrast {observed:.2f}"
