"""Real wheel delivery and independent clipboard oracles for TC-FILE-OPEN-012."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

from .steps import StepError

_STAGE = '[data-testid="file-viewer"][data-active="true"] [data-testid="image-stage"]'
_READ_IMAGE = """async () => {
  for (const item of await navigator.clipboard.read()) {
    if (!item.types.includes('image/png')) continue;
    const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    return btoa(binary);
  }
  throw new Error('Clipboard has no image/png item');
}"""


def validate(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise StepError("viewer_raster: expected wheel deltaY or clipboard kind")
    if args.get("action") == "wheel" and set(args) == {"action", "deltaY"}:
        delta = args["deltaY"]
        if isinstance(delta, int) and not isinstance(delta, bool) and 0 < abs(delta) <= 1200:
            return args
    if args.get("action") == "clipboard" and set(args) == {"action", "kind"} and args["kind"] in {"image", "path"}:
        return args
    raise StepError("viewer_raster: expected {action:wheel,deltaY:nonzero integer -1200..1200} or {action:clipboard,kind:image|path}")


def _fixture(ctx: Any, mode: str) -> dict[str, Any]:
    manifest = json.loads((ctx.case_dir / "file-open-fixture.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "qa.file-open-fixture.v1" or manifest.get("mode") != mode:
        raise StepError("viewer_raster: mismatched fixture receipt")
    oracle = (ctx.case_dir / "raster-original.png").resolve()
    if not oracle.is_relative_to(Path(ctx.report_root).resolve()) or not oracle.is_file():
        raise StepError("viewer_raster: image oracle is not a run-owned fixture")
    return manifest


def _pixels(path: Path) -> dict[str, Any]:
    from PIL import Image
    with Image.open(path) as source:
        image = source.convert("RGBA")
        return {"width": image.width, "height": image.height, "rgba_sha256": hashlib.sha256(image.tobytes()).hexdigest()}


def _record(ctx: Any, observation: dict[str, Any]) -> None:
    with (ctx.case_dir / "raster-observations.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(observation, ensure_ascii=False) + "\n")


def browser(ctx: Any, args: Any) -> None:
    args = validate(args)
    if getattr(ctx, "dry_run", False):
        return
    manifest = _fixture(ctx, "browser")
    if args["action"] == "wheel":
        ctx.page.locator(_STAGE).hover()
        ctx.page.mouse.wheel(0, args["deltaY"])
        _record(ctx, {"mode": "browser", "action": "wheel", "deltaY": args["deltaY"], "input": "Playwright mouse wheel"})
        return
    record: dict[str, Any] = {"mode": "browser", "action": "clipboard", "kind": args["kind"], "passed": False,
                              "boundary": "Chromium clipboard read, not native OS evidence"}
    try:
        if args["kind"] == "path":
            observed = ctx.page.evaluate("() => navigator.clipboard.readText()")
            record["path"] = observed
            if observed != manifest["root"] + "/01-landscape.png":
                raise StepError("viewer_raster: copied browser path differs from original fixture")
        else:
            data = base64.b64decode(ctx.page.evaluate(_READ_IMAGE), validate=True)
            actual = ctx.case_dir / "raster-browser-clipboard.png"
            actual.write_bytes(data)
            expected, observed = _pixels(ctx.case_dir / "raster-original.png"), _pixels(actual)
            record.update(expected=expected, observed=observed)
            if observed != expected:
                raise StepError("viewer_raster: copied browser image pixels differ from original fixture")
        record["passed"] = True
    finally:
        _record(ctx, record)


def native(ctx: Any, args: Any) -> str:
    args = validate(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no input or clipboard read"
    manifest = _fixture(ctx, "native")
    if args["action"] == "wheel":
        from native_pointer import prepare_pointer_target
        element = {"element-6066-11e4-a52e-4f735466cecf": ctx.session.find(_STAGE, interactive=False)}
        point = prepare_pointer_target(ctx.session, element)
        ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{"type": "wheel", "id": "raster-wheel", "actions": [{
            "type": "scroll", "x": point["x"], "y": point["y"], "deltaX": 0, "deltaY": args["deltaY"], "duration": 100, "origin": "viewport",
        }]}]})
        _record(ctx, {"mode": "native", "action": "wheel", "deltaY": args["deltaY"], "input": "W3C WebView wheel", "point": point})
        return "native WebView wheel delivered; not OS-global key evidence"
    from . import host_clipboard
    record: dict[str, Any] = {"mode": "native", "action": "clipboard", "kind": args["kind"], "passed": False,
                              "boundary": "Independent host OS clipboard reader and Pillow pixel digest"}
    try:
        if args["kind"] == "path":
            observed = host_clipboard.get_text()
            record["path"] = observed
            if Path(observed).resolve() != (Path(manifest["root"]) / "01-landscape.png").resolve():
                raise StepError("viewer_raster: copied OS path differs from original fixture")
        else:
            actual = ctx.case_dir / "raster-native-clipboard.png"
            host_clipboard.save_image(actual)
            expected, observed = _pixels(ctx.case_dir / "raster-original.png"), _pixels(actual)
            record.update(expected=expected, observed=observed)
            if observed != expected:
                raise StepError("viewer_raster: copied OS image pixels differ from original fixture")
        record["passed"] = True
    finally:
        _record(ctx, record)
    return "native independent clipboard postcondition matched"
