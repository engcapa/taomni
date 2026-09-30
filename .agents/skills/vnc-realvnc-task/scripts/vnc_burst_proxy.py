#!/usr/bin/env python3
"""Loopback TCP proxy that measures VNC traffic bursts for client comparisons.

Point any VNC client (Taomni, RealVNC Viewer) at 127.0.0.1:<listen> and the
proxy forwards to the real server while logging one line per burst:

    python vnc_burst_proxy.py --target HOST:5900 --listen 5977 --out bursts.jsonl

A burst is downstream data separated from the next chunk by more than
--gap-ms of silence. Each record carries start offset, duration, downstream and
upstream bytes, so "full refresh" and "input -> first update" can be compared
between clients with identical server, network and methodology. The proxy never
parses or logs payload bytes, so credentials and screen content stay private.
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import time


class Recorder:
    def __init__(self, out_path: str | None, gap_ms: float, up_log: str | None = None) -> None:
        self.lock = threading.Lock()
        self.gap = gap_ms / 1000.0
        self.t0 = time.perf_counter()
        self.out = open(out_path, "a", encoding="utf-8") if out_path else None
        self.burst: dict | None = None
        self.up_since_burst = 0
        self.last_up_at: float | None = None
        self.connection = 0
        # Upstream chunk timestamps (time.perf_counter, system-wide QPC on
        # Windows) for input-latency matching; sizes only, never payload.
        self.up_log = open(up_log, "a", encoding="utf-8") if up_log else None

    def _emit(self) -> None:
        burst = self.burst
        if not burst:
            return
        record = {
            "connection": self.connection,
            "start_s": round(burst["start"] - self.t0, 4),
            # Absolute time.perf_counter() values (QPC on Windows) so bursts
            # can be matched with --up-log lines and other probes.
            "start_pc": round(burst["start"], 6),
            "end_pc": round(burst["last"], 6),
            "duration_ms": round((burst["last"] - burst["start"]) * 1000.0, 1),
            "down_bytes": burst["bytes"],
            "chunks": burst["chunks"],
            "up_bytes_before": burst["up_before"],
            "since_last_up_ms": burst["since_up"],
        }
        line = json.dumps(record)
        print(line, flush=True)
        if self.out:
            self.out.write(line + "\n")
            self.out.flush()
        self.burst = None

    def down(self, n: int) -> None:
        now = time.perf_counter()
        with self.lock:
            if self.burst and now - self.burst["last"] > self.gap:
                self._emit()
            if not self.burst:
                since_up = None
                if self.last_up_at is not None:
                    since_up = round((now - self.last_up_at) * 1000.0, 1)
                self.burst = {
                    "start": now,
                    "last": now,
                    "bytes": 0,
                    "chunks": 0,
                    "up_before": self.up_since_burst,
                    "since_up": since_up,
                }
                self.up_since_burst = 0
            self.burst["last"] = now
            self.burst["bytes"] += n
            self.burst["chunks"] += 1

    def up(self, n: int) -> None:
        with self.lock:
            self.up_since_burst += n
            self.last_up_at = time.perf_counter()
            if self.up_log:
                self.up_log.write(f"{self.last_up_at:.6f} {n}\n")
                self.up_log.flush()

    def flush_idle(self) -> None:
        with self.lock:
            if self.burst and time.perf_counter() - self.burst["last"] > self.gap:
                self._emit()


def pump(src: socket.socket, dst: socket.socket, on_bytes) -> None:
    try:
        while True:
            data = src.recv(262144)
            if not data:
                break
            on_bytes(len(data))
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True, help="HOST:PORT of the real VNC server")
    parser.add_argument("--listen", type=int, default=5977)
    parser.add_argument("--gap-ms", type=float, default=120.0)
    parser.add_argument("--out")
    parser.add_argument("--up-log", help="append '<perf_counter> <bytes>' per upstream chunk")
    args = parser.parse_args()
    host, _, port = args.target.rpartition(":")
    recorder = Recorder(args.out, args.gap_ms, args.up_log)

    def ticker() -> None:
        while True:
            time.sleep(recorder.gap / 2)
            recorder.flush_idle()

    threading.Thread(target=ticker, daemon=True).start()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.listen))
    listener.listen(4)
    print(json.dumps({"listening": args.listen, "target_port": int(port)}), flush=True)
    while True:
        client, _ = listener.accept()
        server = socket.create_connection((host, int(port)))
        for sock in (client, server):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with recorder.lock:
            recorder.connection += 1
        threading.Thread(target=pump, args=(server, client, recorder.down), daemon=True).start()
        threading.Thread(target=pump, args=(client, server, recorder.up), daemon=True).start()


if __name__ == "__main__":
    main()
