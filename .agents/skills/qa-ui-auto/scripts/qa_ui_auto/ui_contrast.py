"""Measure rendered sRGB text against solid CSS backgrounds in either WebView."""

import json
import re
import time
from pathlib import Path

from .steps import StepError


def rgba(color: str) -> tuple[float, ...]:
    match = re.fullmatch(r"rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)", color)
    if not match:
        raise StepError(f"Expected computed sRGB color, observed {color}")
    return tuple(float(value) / 255 for value in match.groups()[:3]) + (float(match[4] or 1),)


def over(front, back):
    """Composite two unpremultiplied colors in sRGB paint order."""
    alpha = front[3] + back[3] * (1 - front[3])
    if alpha == 0:
        return (0, 0, 0, 0)
    return tuple((front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha
                 for i in range(3)) + (alpha,)


def luminance(channels) -> float:
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
              for value in channels[:3]]
    return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def ratio(sample, composite):
    ink = rgba(sample["foreground"])
    surface = (0, 0, 0, 0)
    for layer in sample["layers"]:
        color = rgba(layer["color"])
        if layer["effect"] or (surface[3] < 1 and layer["image"] != "none"):
            raise StepError(f"Contrast needs pixel evidence for this layer: {layer}")
        if not composite and (ink[3] < 1 or (surface[3] < 1 and color[3] < 1) or layer["opacity"] < 1):
            raise StepError(f"Expected opaque text and control surface, observed {sample}")
        ink = over(ink, color)
        surface = over(surface, color)
        opacity = layer["opacity"]
        ink = (*ink[:3], ink[3] * opacity)
        surface = (*surface[:3], surface[3] * opacity)
    if surface[3] < 1:
        raise StepError(f"No opaque backing color for {sample}")
    low, high = sorted((luminance(ink), luminance(surface)))
    return (high + 0.05) / (low + 0.05)


def run_contrast(args: dict, evaluate, case_dir: Path) -> str:
    selector = json.dumps(args["selector"])
    query = f"""Array.from(document.querySelectorAll({selector}), element => {{
      const layers = [];
      let animating = false;
      for (let node = element; node; node = node.parentElement) {{
        const style = getComputedStyle(node);
        layers.push({{color: style.backgroundColor, image: style.backgroundImage, opacity: Number(style.opacity),
          effect: style.mixBlendMode !== 'normal' || style.filter !== 'none'}});
        animating ||= node.getAnimations().some(animation => animation.playState === 'running');
      }}
      const box = element.getBoundingClientRect();
      return {{foreground: getComputedStyle(element).color, background: layers[0].color, layers, animating,
        visible: box.height > 0 && box.width > 0 && getComputedStyle(element).visibility === 'visible'}};
    }})"""
    deadline = time.monotonic() + 3
    while True:
        values = evaluate(query)
        if values and all(not sample["animating"] for sample in values):
            break
        if time.monotonic() >= deadline:
            raise StepError(f"Expected a settled control matching {selector}, observed {values}")
        time.sleep(0.05)
    for sample in values:
        if not sample["visible"]:
            raise StepError(f"Expected a visible control for {selector}")
        sample["ratio"] = ratio(sample, args.get("composite_ancestors", False))
    with (case_dir / "contrast.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"selector": args["selector"], "samples": values}) + "\n")
    observed = min(item["ratio"] for item in values)
    if observed < args["minimum"]:
        raise StepError(f"{selector} contrast {observed:.2f} below {args['minimum']}")
    return f"{selector} minimum measured contrast {observed:.2f}"
