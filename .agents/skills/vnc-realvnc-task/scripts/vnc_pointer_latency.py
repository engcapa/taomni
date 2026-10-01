#!/usr/bin/env python3
"""Measure client-side pointer latency: OS cursor move -> PointerEvent on the wire.

Run vnc_burst_proxy.py with --up-log, focus the VNC client window, then:

    python vnc_pointer_latency.py --up-log up.log --x 900 --y 500 --moves 40

Moves the cursor in small steps inside the viewer (no clicks, no keys), and
matches each move with the first upstream chunk that follows it. Uses
time.perf_counter, which is QueryPerformanceCounter (system-wide) on Windows,
so the proxy and this script share one clock. Windows only.
"""

from __future__ import annotations

import argparse
import ctypes
import statistics
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--up-log", required=True)
    parser.add_argument("--x", type=int, required=True)
    parser.add_argument("--y", type=int, required=True)
    parser.add_argument("--moves", type=int, default=40)
    parser.add_argument("--interval-ms", type=float, default=120.0)
    parser.add_argument("--label", default="client")
    parser.add_argument(
        "--size",
        type=int,
        action="append",
        help="only count upstream chunks of this size (6 for plain RFB PointerEvent; TLS sessions wrap it, e.g. 35)",
    )
    parser.add_argument("--dump", help="append {label, latencies_ms} as one JSON line (pool runs later)")
    args = parser.parse_args()
    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()
    with open(args.up_log, "a", encoding="utf-8"):
        pass
    start_offset = sum(1 for _ in open(args.up_log, encoding="utf-8"))
    moves: list[float] = []
    for i in range(args.moves):
        dx = (i % 10) * 4
        t = time.perf_counter()
        user32.SetCursorPos(args.x + dx, args.y + (i // 10) * 4)
        moves.append(t)
        time.sleep(args.interval_ms / 1000.0)
    time.sleep(0.5)
    ups = []
    with open(args.up_log, encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            if index < start_offset:
                continue
            stamp, size = line.split()
            if args.size and int(size) not in args.size:
                continue
            ups.append((float(stamp), int(size)))
    latencies = []
    for t in moves:
        after = [stamp for stamp, _ in ups if stamp >= t and stamp - t < args.interval_ms / 1000.0]
        if after:
            latencies.append((after[0] - t) * 1000.0)
    if not latencies:
        print(f"{args.label}: no upstream pointer traffic matched")
        return
    if args.dump:
        import json

        with open(args.dump, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"label": args.label, "moves": len(moves),
                                     "latencies_ms": [round(v, 3) for v in latencies]}) + "\n")
    latencies.sort()
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
    print(
        f"{args.label}: matched={len(latencies)}/{len(moves)} median_ms={statistics.median(latencies):.2f} "
        f"p95_ms={p95:.2f} min_ms={latencies[0]:.2f} max_ms={latencies[-1]:.2f}"
    )


if __name__ == "__main__":
    main()
