#!/usr/bin/env python3
"""Measure how soon a VNC client asks for the next update after receiving one.

Inputs are the two logs written by vnc_burst_proxy.py for one session:

    python vnc_request_cadence.py --bursts bursts.jsonl --up-log up.log --label taomni

For every downstream burst of at least --min-bytes, the first upstream chunk
of exactly 10 bytes (an RFB FramebufferUpdateRequest; pointer events are 6
bytes, key events 8) after the burst ends is taken as the client's next
request. TLS-wrapped sessions (Taomni prefers RFB security type 18) change
record sizes: pass --any-size and keep the pointer and keyboard idle. Prints
median/p95 of burst end -> next request. Only sizes and
timestamps are read; no payload is ever logged by the proxy.
"""

from __future__ import annotations

import argparse
import json
import statistics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bursts", required=True)
    parser.add_argument("--up-log", required=True)
    parser.add_argument("--min-bytes", type=int, default=4096)
    parser.add_argument("--window-ms", type=float, default=2000.0)
    parser.add_argument("--since-pc", type=float, default=0.0, help="ignore records before this perf_counter value")
    parser.add_argument("--any-size", action="store_true", help="count any upstream chunk (TLS sessions)")
    parser.add_argument("--request-size", type=int, default=10,
                        help="upstream chunk size of one update request (10 plain; 39 for Taomni's anonymous TLS)")
    parser.add_argument("--label", default="client")
    args = parser.parse_args()

    bursts = []
    with open(args.bursts, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if "end_pc" in record and record["down_bytes"] >= args.min_bytes and record["start_pc"] >= args.since_pc:
                bursts.append(record)
    requests = []
    with open(args.up_log, encoding="utf-8") as handle:
        for line in handle:
            stamp, size = line.split()
            if (args.any_size or int(size) == args.request_size) and float(stamp) >= args.since_pc:
                requests.append(float(stamp))
    delays = []
    for burst in bursts:
        after = [stamp for stamp in requests if burst["end_pc"] <= stamp <= burst["end_pc"] + args.window_ms / 1000.0]
        if after:
            delays.append((after[0] - burst["end_pc"]) * 1000.0)
    if not delays:
        print(f"{args.label}: no update->request pairs in {len(bursts)} bursts")
        return
    delays.sort()
    p95 = delays[min(len(delays) - 1, int(len(delays) * 0.95))]
    print(
        f"{args.label}: pairs={len(delays)}/{len(bursts)} median_ms={statistics.median(delays):.1f} "
        f"p95_ms={p95:.1f} max_ms={delays[-1]:.1f}"
    )


if __name__ == "__main__":
    main()
