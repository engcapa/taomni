#!/usr/bin/env python3
"""Split native pointer latency into OS → WebView → JS → wire segments.

Used by the `pointer-trace` scenario of vnc_native.py: TRACE_HOOK records, in
the page's clock, each pointer event's timeStamp (when the browser received the
OS event), when the window-level capture listener ran, and every 6-byte
PointerEvent WebSocket send. vnc_pointer_latency.py --raw-dump records the OS
move and the wire arrival in perf_counter time. The page clock is mapped onto
perf_counter with the smallest send → wire gap, so `send_to_wire` is relative
to the fastest observed transit (its minimum is 0 by construction).
"""

from __future__ import annotations

import statistics

TRACE_HOOK = r"""
if (!window.__vncTrace) {
  const trace = window.__vncTrace = {events: [], sends: []};
  const listener = (e) => trace.events.push([e.timeStamp, performance.now(), e.type === 'pointerrawupdate' ? 1 : 0]);
  window.addEventListener('pointerrawupdate', listener, {capture: true, passive: true});
  window.addEventListener('pointermove', listener, {capture: true, passive: true});
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (data instanceof ArrayBuffer && data.byteLength === 6 && new Uint8Array(data)[0] === 3) {
      trace.sends.push(performance.now());
    }
    return send.call(this, data);
  };
}
window.__vncTrace.events.length = 0;
window.__vncTrace.sends.length = 0;
return true;
"""

SEGMENTS = ("os_to_event", "event_to_listener", "listener_to_send", "send_to_wire", "total")


def clusters(times: list[float], gap_ms: float) -> list[list[float]]:
    """Group sorted page-clock times separated by more than gap_ms."""
    groups: list[list[float]] = []
    for value in sorted(times):
        if groups and value - groups[-1][-1] <= gap_ms:
            groups[-1].append(value)
        else:
            groups.append([value])
    return groups


def segments(pairs: list[list[float | None]], trace: dict, gap_ms: float = 80.0) -> list[dict]:
    """Per-move segments in ms. `pairs` are [move, wire] perf_counter seconds;
    `trace` is window.__vncTrace. The last len(pairs) event and send clusters
    are the moves (a focus move before the run adds a leading cluster)."""
    raw = [event for event in trace["events"] if event[2] == 1]
    events = raw or trace["events"]  # WebKit has no pointerrawupdate
    by_stamp = {event[0]: event for event in events}
    event_groups = clusters([event[0] for event in events], gap_ms)
    send_groups = clusters(list(trace["sends"]), gap_ms)
    count = len(pairs)
    if len(event_groups) < count or len(send_groups) < count:
        raise ValueError(f"{count} moves but {len(event_groups)} event / {len(send_groups)} send clusters")
    event_groups, send_groups = event_groups[-count:], send_groups[-count:]
    matched = [(pair, by_stamp[group[0]], sends[0])
               for pair, group, sends in zip(pairs, event_groups, send_groups) if pair[1] is not None]
    if not matched:
        return []
    offset = min(wire * 1000.0 - send for (_, wire), _, send in matched)
    rows = []
    for (move, wire), (stamp, listener, _), send in matched:
        rows.append({
            "os_to_event": stamp + offset - move * 1000.0,
            "event_to_listener": listener - stamp,
            "listener_to_send": send - listener,
            "send_to_wire": wire * 1000.0 - (send + offset),
            "total": (wire - move) * 1000.0,
        })
    return rows


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summary(rows: list[dict]) -> dict:
    """Median/p90/p95 per segment, and each segment's median among the slowest
    10% of moves (which segment carries the tail)."""
    if not rows:
        return {}
    cut = percentile([row["total"] for row in rows], 0.9)
    tail = [row for row in rows if row["total"] >= cut]
    return {
        name: {
            "median": round(statistics.median(row[name] for row in rows), 2),
            "p90": round(percentile([row[name] for row in rows], 0.9), 2),
            "p95": round(percentile([row[name] for row in rows], 0.95), 2),
            "tail_median": round(statistics.median(row[name] for row in tail), 2),
        }
        for name in SEGMENTS
    } | {"samples": len(rows), "tail_samples": len(tail)}
