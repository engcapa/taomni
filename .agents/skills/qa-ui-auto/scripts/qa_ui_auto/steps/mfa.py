"""Browser verbs for the MFA authenticator cases (docs-feature/mfa-authenticator-design.md).

``seed_clipboard_image`` puts a real PNG on Chromium's clipboard and
``browser_fake_camera`` replaces the camera with a canvas stream showing a QR
image. Both are controlled fixtures: they prove the renderer's paste, scan and
decode paths, never the OS clipboard, camera hardware or permissions (native
cases and the manual V-25 check own those). ``assert_totp_code`` recomputes
RFC 6238 in Python instead of trusting the product's arithmetic.
"""

from __future__ import annotations

import base64
from typing import Any

from . import StepContext, StepError, verb

_SEED_IMAGE_JS = """async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
  const items = await navigator.clipboard.read();
  return items.some((item) => item.types.includes("image/png"));
}"""

# Overrides the page's MediaDevices with one fake camera. `qr` streams the
# fixture image from a canvas; `none` reports no device; `denied` rejects
# getUserMedia like a refused permission prompt. Tracks stay observable through
# window.__taomniQaCamera so a case can prove the app released the camera.
_FAKE_CAMERA_JS = """async (cfg) => {
  const media = navigator.mediaDevices;
  if (!media) throw new Error("navigator.mediaDevices is unavailable");
  const tracks = [];
  let image = null;
  if (cfg.mode === "qr") {
    image = new Image();
    image.src = cfg.dataUrl;
    await image.decode();
  }
  const device = { deviceId: "qa-fake-camera", groupId: "qa-fake", kind: "videoinput", label: "QA fake camera" };
  device.toJSON = () => ({ ...device });
  media.enumerateDevices = async () => (cfg.mode === "none" ? [] : [device]);
  media.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.video || cfg.mode === "none") {
      throw new DOMException("Requested device not found", "NotFoundError");
    }
    if (cfg.mode === "denied") throw new DOMException("Permission denied", "NotAllowedError");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    const scale = Math.min(1, (canvas.height - 40) / image.height, (canvas.width - 40) / image.width);
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);
    const paint = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, (canvas.width - width) >> 1, (canvas.height - height) >> 1, width, height);
    };
    paint();
    const stream = canvas.captureStream(15);
    stream.getTracks().forEach((track) => tracks.push(track));
    const timer = setInterval(() => {
      if (stream.getTracks().every((track) => track.readyState === "ended")) clearInterval(timer);
      else paint();
    }, 100);
    return stream;
  };
  window.__taomniQaCamera = {
    mode: cfg.mode,
    get created() { return tracks.length; },
    get live() { return tracks.filter((track) => track.readyState === "live").length; },
  };
  return true;
}"""

_CAMERA_MODES = {"qr", "none", "denied"}


@verb("seed_clipboard_image")
def step_seed_clipboard_image(ctx: StepContext, args: Any) -> None:
    """Put a PNG on the browser clipboard as image/png and read it back.

    `{path}` uses a fixture file; `{selector}` screenshots one rendered element
    (e.g. the exported MFA QR code) so the app's own import path can scan it.
    """
    from ..mfa_support import png_fixture

    if isinstance(args, dict) and "selector" in args:
        if not isinstance(args["selector"], str) or not args["selector"]:
            raise StepError("seed_clipboard_image: selector must be a non-empty string")
        if ctx.dry_run:
            return
        data = ctx.page.locator(args["selector"]).first.screenshot()  # type: ignore[attr-defined]
        ctx.case_dir.mkdir(parents=True, exist_ok=True)
        (ctx.case_dir / f"clipboard-image-step{ctx.step_index}.png").write_bytes(data)
    else:
        path = args.get("path") if isinstance(args, dict) else args
        _, data = png_fixture(path, "seed_clipboard_image")
        if ctx.dry_run:
            return
    ok = ctx.page.evaluate(_SEED_IMAGE_JS, base64.b64encode(data).decode("ascii"))  # type: ignore[attr-defined]
    if ok is not True:
        raise StepError("seed_clipboard_image: clipboard read-back has no image/png item")


@verb("browser_fake_camera")
def step_browser_fake_camera(ctx: StepContext, args: Any) -> None:
    """Install a fake camera (`qr` + image, `none`, or `denied`) for this page."""
    from ..mfa_support import png_fixture

    if not isinstance(args, dict) or args.get("mode") not in _CAMERA_MODES:
        raise StepError("browser_fake_camera: expected {mode: qr|none|denied, image?}")
    mode = args["mode"]
    data_url = None
    if mode == "qr":
        _, data = png_fixture(args.get("image"), "browser_fake_camera")
        data_url = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    if ctx.dry_run:
        return
    ctx.page.evaluate(_FAKE_CAMERA_JS, {"mode": mode, "dataUrl": data_url})  # type: ignore[attr-defined]


@verb("assert_totp_code")
def step_assert_totp_code(ctx: StepContext, args: Any) -> None:
    from ..mfa_support import assert_totp_code, totp_args

    if ctx.dry_run:
        totp_args(args)
        return
    assert_totp_code(lambda expression: ctx.page.evaluate(f"() => ({expression})"), args)  # type: ignore[attr-defined]
