"""Bounded independent compositor pixels from the job-owned GNOME Shell.

This does not create a portal/ScreenCast session, flash, notification or chooser.
The broker exposes this fixed operation, never arbitrary caller-supplied Eval.
"""
from __future__ import annotations

import math

GRID = (48, 27)

# GNOME Shell 50.1 js/ui/screenshot.js promisifies both methods below. Shell's
# EvalAsync awaits the returned Promise. The native stage capture occurs before
# screenshot_stage_to_content() returns its Promise; PNG encoding happens later.
CAPTURE_GRID = r"""(async () => {
    const rect = RECT;
    const Shell = imports.gi.Shell;
    const Gio = imports.gi.Gio;
    const GLib = imports.gi.GLib;
    const monitor = Main.layoutManager.monitors.find(m =>
        m.x === rect.x && m.y === rect.y &&
        m.width === rect.width && m.height === rect.height);
    if (!monitor)
        throw new Error('capture rectangle is not an actual owned monitor');
    const shooter = new Shell.Screenshot();
    const captureStartedMs = Date.now();
    const captureStartedMonoMs = GLib.get_monotonic_time() / 1000;
    const pending = shooter.screenshot_stage_to_content();
    const captureEndedMonoMs = GLib.get_monotonic_time() / 1000;
    const captureEndedMs = Date.now();
    const [content, scale] = await pending;
    const texture = content.get_texture();
    const stream = Gio.MemoryOutputStream.new_resizable();
    let pixbuf;
    try {
        pixbuf = await Shell.Screenshot.composite_to_stream(
            texture, Math.round(rect.x * scale), Math.round(rect.y * scale),
            Math.round(rect.width * scale), Math.round(rect.height * scale),
            scale, null, 0, 0, 1, stream);
    } finally {
        stream.close(null);
    }
    const width = pixbuf.get_width(), height = pixbuf.get_height();
    const stride = pixbuf.get_rowstride(), channels = pixbuf.get_n_channels();
    const bytes = pixbuf.get_pixels();
    const points = [];
    for (let gy = 0; gy < 27; gy++) {
        for (let gx = 0; gx < 48; gx++) {
            const x = Math.min(width - 1, Math.floor((gx * 2 + 1) * width / 96));
            const y = Math.min(height - 1, Math.floor((gy * 2 + 1) * height / 54));
            const offset = y * stride + x * channels;
            points.push([bytes[offset], bytes[offset + 1], bytes[offset + 2]]);
        }
    }
    return {captureStartedMs, captureEndedMs, captureStartedMonoMs,
        captureEndedMonoMs, width, height, points,
        transport: 'owned GNOME Shell.Screenshot stage pixels (no portal)'};
})()"""


def capture_grid(evaluate, rectangle):
    if (not isinstance(rectangle, dict) or set(rectangle) != {"x", "y", "width", "height"}
            or any(type(value) is not int for value in rectangle.values())
            or rectangle["x"] < 0 or rectangle["y"] < 0
            or not 0 < rectangle["width"] <= 16384
            or not 0 < rectangle["height"] <= 16384):
        raise ValueError("capture_grid requires one actual monitor rectangle")
    import json
    result = evaluate(CAPTURE_GRID.replace("RECT", json.dumps(rectangle), 1))
    if not isinstance(result, dict):
        raise RuntimeError("GNOME capture returned no pixel evidence")
    times = [result.get(key) for key in ("captureStartedMs", "captureEndedMs",
                                       "captureStartedMonoMs", "captureEndedMonoMs")]
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in times)
            or times[1] < times[0] or times[3] < times[2]):
        raise RuntimeError("GNOME capture returned invalid capture timestamps")
    points = result.get("points")
    if (not isinstance(points, list) or len(points) != GRID[0] * GRID[1]
            or any(not isinstance(pixel, list) or len(pixel) != 3
                   or any(type(c) is not int or not 0 <= c <= 255 for c in pixel)
                   for pixel in points)
            or any(type(result.get(key)) is not int or not 0 < result[key] <= 32768
                   for key in ("width", "height"))):
        raise RuntimeError("GNOME capture returned an invalid pixel grid")
    return result
