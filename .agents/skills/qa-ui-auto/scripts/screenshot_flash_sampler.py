"""Independent, killable native display sampler for TC-SHOT-N28.

One process owns fresh snapshots, has a finite lifetime and writes incremental
JSONL evidence. No product capture stream, cached frame or WebView screenshot is
used. The parent owns this process/group and terminates it on every exit path.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import platform
import time

GRID = (48, 27)
STEP_SEC = 0.05
MAX_LIFETIME_SEC = 45
UNIFORM_SHARE = 0.97


def summarize(points):
    if len(points) != GRID[0] * GRID[1]:
        raise ValueError("missing independent pixel grid")
    count, color = max((sum(all(abs(a - b) <= 12 for a, b in zip(pixel, candidate))
                            for pixel in points), candidate)
                       for candidate in points[::37])
    return count / len(points), list(color)


def grid(image):
    image = image.convert("RGB")
    width, height = image.size
    return [image.getpixel((min(width - 1, (gx * 2 + 1) * width // (GRID[0] * 2)),
                            min(height - 1, (gy * 2 + 1) * height // (GRID[1] * 2))))
            for gy in range(GRID[1]) for gx in range(GRID[0])]


class MacSnapshot:
    """Fresh CoreGraphics readback without a display stream or helper child."""
    def __init__(self, rectangle, scale):
        class Point(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
        class Size(ctypes.Structure):
            _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]
        class Rect(ctypes.Structure):
            _fields_ = [("origin", Point), ("size", Size)]
        self.rect = Rect(Point(rectangle["x"] / scale, rectangle["y"] / scale),
                         Size(rectangle["width"] / scale, rectangle["height"] / scale))
        self.cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.cg.CGWindowListCreateImage.argtypes = [Rect, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32]
        self.cg.CGWindowListCreateImage.restype = ctypes.c_void_p
        for name in ("CGImageGetWidth", "CGImageGetHeight", "CGImageGetBytesPerRow",
                     "CGImageGetBitsPerComponent", "CGImageGetBitsPerPixel", "CGImageGetBitmapInfo"):
            function = getattr(self.cg, name)
            function.argtypes = [ctypes.c_void_p]
            function.restype = ctypes.c_size_t
        for name in ("CGImageGetDataProvider", "CGDataProviderCopyData"):
            function = getattr(self.cg, name)
            function.argtypes = [ctypes.c_void_p]
            function.restype = ctypes.c_void_p
        self.cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
        self.cf.CFDataGetLength.restype = ctypes.c_long
        self.cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        self.cf.CFDataGetBytePtr.restype = ctypes.POINTER(ctypes.c_ubyte)
        self.cf.CFRelease.argtypes = [ctypes.c_void_p]

    def __call__(self):
        image = self.cg.CGWindowListCreateImage(self.rect, 0, 0, 0)
        if not image:
            raise RuntimeError("CoreGraphics display snapshot unavailable/permission denied")
        data = None
        try:
            width, height, stride, component, bits, info = [getattr(self.cg, name)(image) for name in (
                "CGImageGetWidth", "CGImageGetHeight", "CGImageGetBytesPerRow",
                "CGImageGetBitsPerComponent", "CGImageGetBitsPerPixel", "CGImageGetBitmapInfo")]
            # CoreGraphics default snapshots are little-endian xRGB/BGRA. Never
            # invent colours for an unexpected OS pixel format.
            if (not width or not height or component != 8 or bits != 32
                    or info & 0x7000 not in (0, 0x2000) or info & 0x1f not in (2, 4, 6)):
                raise RuntimeError(f"unsupported CoreGraphics snapshot layout: {component}/{bits}/{info}")
            provider = self.cg.CGImageGetDataProvider(image)
            data = self.cg.CGDataProviderCopyData(provider)
            if not data or self.cf.CFDataGetLength(data) < stride * height:
                raise RuntimeError("CoreGraphics snapshot has incomplete pixel data")
            pixels = self.cf.CFDataGetBytePtr(data)
            points = []
            for gy in range(GRID[1]):
                for gx in range(GRID[0]):
                    x = min(width - 1, (gx * 2 + 1) * width // (GRID[0] * 2))
                    y = min(height - 1, (gy * 2 + 1) * height // (GRID[1] * 2))
                    offset = y * stride + x * 4
                    points.append([pixels[offset + 2], pixels[offset + 1], pixels[offset]])
            return {"width": width, "height": height, "points": points,
                    "transport": "independent CoreGraphics CGWindowListCreateImage"}
        finally:
            if data:
                self.cf.CFRelease(data)
            self.cf.CFRelease(image)


def capture_source(rectangle, scale):
    system = platform.system()
    if os.environ.get("GDK_BACKEND", "").split(",")[0] == "wayland":
        from qa_ui_auto.wayland import command
        logical = {key: round(value / scale) for key, value in rectangle.items()}
        return lambda: command("capture_grid", rect=logical)
    if system == "Darwin":
        return MacSnapshot(rectangle, scale)
    from PIL import ImageGrab
    if system == "Windows":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            ctypes.windll.user32.SetProcessDPIAware()
    bbox = (rectangle["x"], rectangle["y"], rectangle["x"] + rectangle["width"],
            rectangle["y"] + rectangle["height"])

    def capture():
        options = {"all_screens": True} if system == "Windows" else {"xdisplay": os.environ["DISPLAY"]}
        image = ImageGrab.grab(bbox=bbox, **options)
        return {"width": image.width, "height": image.height, "points": grid(image),
                "transport": "independent fresh GDI ImageGrab" if system == "Windows"
                else "independent fresh X11 ImageGrab"}
    return capture


def run(capture, stream, stop, *, lifetime=MAX_LIFETIME_SEC):
    expires = time.monotonic() + lifetime
    index = 0
    while not stop.exists() and time.monotonic() < expires:
        scheduled = time.monotonic()
        started_wall, started_mono = time.time_ns() / 1e6, time.monotonic_ns() / 1e6
        frame = capture()
        ended_mono, ended_wall = time.monotonic_ns() / 1e6, time.time_ns() / 1e6
        # The broker brackets its synchronous stage readback; an external
        # snapshot is conservatively bracketed by its full native invocation.
        sample = {"captureStartedMs": started_wall, "captureEndedMs": ended_wall,
                  "captureStartedMonoMs": started_mono, "captureEndedMonoMs": ended_mono,
                  **frame}
        share, color = summarize(sample.pop("points"))
        sample.update(kind="sample", index=index, modalShare=share, modalColor=color)
        stream.write(json.dumps(sample) + "\n")
        stream.flush()
        index += 1
        time.sleep(max(0, STEP_SEC - (time.monotonic() - scheduled)))
    if not stop.exists():
        raise RuntimeError("independent sampler reached its finite lifetime")
    stream.write(json.dumps({"kind": "stopped", "samples": index}) + "\n")
    stream.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stop", type=Path, required=True)
    parser.add_argument("--rect", required=True)
    parser.add_argument("--scale", type=float, required=True)
    args = parser.parse_args()
    # Under -I, only this repository-controlled script directory is added. Do
    # not import modules from the output/runtime directory or arbitrary cwd.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    with args.output.open("x", encoding="utf-8", buffering=1) as stream:
        try:
            run(capture_source(json.loads(args.rect), args.scale), stream, args.stop)
        except Exception as error:
            stream.write(json.dumps({"kind": "error", "error": str(error)}) + "\n")
            raise


if __name__ == "__main__":
    main()
