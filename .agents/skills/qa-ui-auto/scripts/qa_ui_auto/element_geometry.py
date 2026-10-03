"""Read and assert actual element dimensions in browser and packaged WebViews."""
from __future__ import annotations

import json
import math
from pathlib import Path

from .steps import StepError


def assert_geometry(args: dict, measurements: list[dict]) -> None:
    prefix = f"assert_element_geometry: {args['selector']}"
    if len(measurements) < args.get("min_count", 1):
        raise StepError(f"{prefix}: matched {len(measurements)} elements")
    tolerance = args.get("tolerance", 1)
    for item in measurements:
        label = item.get("id", "element")
        for dimension in ("width", "height"):
            value = item[dimension]
            minimum = args[f"min_{dimension}"]
            if not math.isfinite(value) or value < minimum:
                raise StepError(f"{prefix}: {label} {dimension} {value} < {minimum}")
        if args.get("same_width") and abs(item["width"] - measurements[0]["width"]) > tolerance:
            raise StepError(f"{prefix}: {label} width {item['width']} differs from {measurements[0]['width']}")
        if "icon_size" in args:
            icon = item.get("icon")
            if not icon or any(not math.isfinite(icon[key]) or abs(icon[key] - args["icon_size"]) > tolerance
                               for key in ("width", "height")):
                raise StepError(f"{prefix}: {label} icon {icon} differs from {args['icon_size']}px")


def run_geometry(args: dict, evaluate, case_dir: Path) -> str:
    selector = json.dumps(args["selector"])
    expression = f"""Array.from(document.querySelectorAll({selector}), element => {{
      const rect = element.getBoundingClientRect();
      const icon = element.querySelector('svg')?.getBoundingClientRect();
      return {{id: element.getAttribute('data-testid') || element.id || element.tagName,
        width: rect.width, height: rect.height,
        icon: icon ? {{width: icon.width, height: icon.height}} : null}};
    }})"""
    measurements = evaluate(expression)
    with (case_dir / "element-geometries.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"expected": args, "measurements": measurements}) + "\n")
    assert_geometry(args, measurements)
    return f"checked dimensions of {len(measurements)} elements"
