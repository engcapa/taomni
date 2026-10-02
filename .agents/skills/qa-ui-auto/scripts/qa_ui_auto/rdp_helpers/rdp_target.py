"""Host-side visual target for RDP server tests (stdlib Tk only).

Runs as a separate process on the machine whose desktop the RDP server
shares. `rdp-probe latency` clicks (or types) on it and measures the time
until the pixels change in the decoded RDP framebuffer; `throughput` watches
the animation. Every state change is written atomically to `--state` so a
testcase can prove that input injected over RDP really reached a host
window (instead of trusting the server's own logs).

Modes:
  flip     black/white square that inverts on each click or key press
  animate  vertical bars scrolling at ~60 Hz (frame counter in the state file)
  photo    deterministic noisy panning gradient, with the same frame marker
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import tkinter as tk
from pathlib import Path


def write_state(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


def photo_noise(width: int, height: int, frame: int) -> bytes:
    """Same xorshift recurrence as encoder-experiment/photo_desktop."""
    seed = (0x9E3779B9 * (frame + 1)) & 0xFFFFFFFF
    result = bytearray(width * height)
    for index in range(len(result)):
        seed ^= (seed << 13) & 0xFFFFFFFF
        seed ^= seed >> 17
        seed ^= (seed << 5) & 0xFFFFFFFF
        result[index] = seed & 0x1F
    return bytes(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry", default="480x320+40+80", help="WxH+X+Y in desktop pixels")
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--mode", choices=["flip", "animate", "photo"], default="flip")
    parser.add_argument("--pattern", action="store_true", help="Known magenta/cyan markers for mstsc screenshot verification")
    parser.add_argument("--lifetime-sec", type=float, default=900.0)
    args = parser.parse_args()

    if sys.platform == "win32":
        # Desktop coordinates must be physical pixels, matching RDP capture.
        try:
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:  # noqa: BLE001 - older Windows
            pass

    root = tk.Tk()
    root.title("taomni-rdp-target")
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.geometry(args.geometry)
    width, height = (int(v) for v in args.geometry.split("+", 1)[0].split("x"))
    canvas = tk.Canvas(root, width=width, height=height, highlightthickness=0, bg="#000000")
    canvas.pack(fill="both", expand=True)
    state = {
        "mode": args.mode,
        "pid": os.getpid(),
        "geometry": args.geometry,
        "flips": 0,
        "color": "#000000",
        "frames": 0,
        "last_event_unix_ms": None,
        "ready": False,
    }

    def flip(_event: object = None) -> None:
        state["flips"] += 1
        state["color"] = "#ffffff" if state["color"] == "#000000" else "#000000"
        state["last_event_unix_ms"] = int(time.time() * 1000)
        canvas.configure(bg=state["color"])
        root.update_idletasks()
        write_state(args.state, state)

    bars: list[int] = []
    if args.mode in {"animate", "photo"}:
        bar_w = max(8, width // 24)
        photo_image = None
        if args.mode == "photo":
            import numpy as np
            # Reuse a deterministic 16-frame noise cycle so fixture generation
            # does not compete with the encoder during the measured window.
            noise = [np.frombuffer(photo_noise(width, height, frame), dtype=np.uint8).reshape(height, width).astype(np.int16) - 16 for frame in range(16)]
            xx, yy = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
            photo_image = tk.PhotoImage(width=width, height=height)
            canvas.create_image(0, 0, image=photo_image, anchor="nw")
        else:
            for i in range(0, width + bar_w * 2, bar_w * 2):
                bars.append(canvas.create_rectangle(i, 0, i + bar_w, height, fill="#ffffff", width=0))
        # Frame marker: a 32x32 square in the window's top-left corner whose
        # grey level steps through 16 values (frame % 16), coarse enough to
        # survive lossy codecs. `rdp-probe throughput --marker` counts the
        # level steps to get delivered animation frames per second.
        marker = canvas.create_rectangle(0, 0, 32, 32, fill="#080808", width=0)
        state["marker"] = {"x": 16, "y": 16, "levels": 16}
        last_written = [time.monotonic()]

        def step() -> None:
            state["frames"] += 1
            if photo_image is not None:
                frame = state["frames"]
                base = ((xx + (frame * 3) % width) / width * 180.0 + yy / height * 60.0).astype(np.int16)
                value = np.clip(base + noise[frame % 16], 0, 255).astype(np.uint8)
                rgb = np.stack((value // 2, value + np.uint8(20), value), axis=2)
                ppm = f"P6\n{width} {height}\n255\n".encode() + rgb.tobytes()
                photo_image.configure(data=ppm, format="PPM")
            level = (state["frames"] % 16) * 16 + 8
            canvas.itemconfigure(marker, fill=f"#{level:02x}{level:02x}{level:02x}")
            canvas.tag_raise(marker)
            for bar in bars:
                canvas.move(bar, 4, 0)
                x0, _, _, _ = canvas.coords(bar)
                if x0 > width:
                    canvas.move(bar, -(width + bar_w * 2), 0)
            now = time.monotonic()
            if now - last_written[0] >= 1.0:
                last_written[0] = now
                write_state(args.state, state)
            root.after(16, step)

        root.after(16, step)
    else:
        canvas.bind("<Button-1>", flip)
        root.bind("<Key>", flip)
        if args.pattern:
            canvas.create_rectangle(0, 0, 96, 96, fill="#ff00ff", width=0)
            canvas.create_rectangle(96, 0, 192, 96, fill="#00ffff", width=0)

    def mark_ready() -> None:
        root.lift()
        root.focus_force()
        state["ready"] = True
        state["window"] = {
            "x": root.winfo_rootx(),
            "y": root.winfo_rooty(),
            "width": root.winfo_width(),
            "height": root.winfo_height(),
        }
        write_state(args.state, state)

    root.after(300, mark_ready)
    root.after(int(args.lifetime_sec * 1000), root.destroy)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
