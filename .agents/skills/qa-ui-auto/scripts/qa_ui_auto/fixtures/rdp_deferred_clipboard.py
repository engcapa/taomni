"""Publish real macOS text after its pasteboard type/change token is visible.

This deliberately separates declaration and data publication through AppKit.
No app state, token, protocol event or server result is mocked.
"""
import json
from pathlib import Path
import platform

from .. import host_clipboard

TARGET_TEXT = "joint-clipboard 联合 ✓ no-echo"
SCRIPT = host_clipboard._JXA_PRELUDE + """
pb.clearContents;
pb.declareTypesOwner($.NSArray.arrayWithObject($.NSPasteboardTypeString), null);
var token = Number(pb.changeCount);
var began = Date.now();
$.NSThread.sleepForTimeInterval(1.2);
var published = Boolean(pb.setStringForType($(arg), $.NSPasteboardTypeString));
JSON.stringify({declaredToken:token, publishedToken:Number(pb.changeCount),
                heldMs:Date.now()-began, published:published});
"""


def publish(text: str, destination: Path) -> None:
    observation = json.loads(host_clipboard._jxa(SCRIPT, text))
    destination.write_text(json.dumps(observation, indent=2) + "\n", encoding="utf-8")
    if not isinstance(observation, dict) or any(
        type(observation.get(key)) is not int or observation[key] < 0
        for key in ("declaredToken", "publishedToken", "heldMs")
    ):
        raise RuntimeError("AppKit returned incomplete publication observations")
    if observation.get("published") is not True:
        raise RuntimeError("AppKit rejected the delayed clipboard text")
    if observation.get("declaredToken") != observation.get("publishedToken"):
        raise RuntimeError("Deferred-text fixture changed the token while publishing data")
    if observation.get("heldMs", 0) < 1200:
        raise RuntimeError("Deferred-text fixture did not hold declaration before data publication")


def setup(ctx) -> None:
    if platform.system() != "Darwin":
        return
    original = host_clipboard.set_text

    def set_text(text):
        if text == TARGET_TEXT:
            publish(text, Path(ctx.case_dir) / "deferred-clipboard-publication.json")
        else:
            original(text)

    ctx._deferred_clipboard_setter = original
    host_clipboard.set_text = set_text


def teardown(ctx) -> None:
    original = getattr(ctx, "_deferred_clipboard_setter", None)
    if original is not None:
        host_clipboard.set_text = original
        del ctx._deferred_clipboard_setter
