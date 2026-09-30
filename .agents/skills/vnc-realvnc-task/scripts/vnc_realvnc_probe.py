#!/usr/bin/env python3
"""Drive RealVNC Viewer against vnc_fixture_server.py and read its protocol behaviour.

    python vnc_realvnc_probe.py --viewer C:/software/realvnc-viewer/VNC-Viewer-7.15.1-Windows-64bit.exe \
        --port 5988 --password-env TAOMNI_VNC_FIXTURE_PASSWORD --fixture-log fx.jsonl --fixture-control 5989 \
        --report qa-ui-auto-report/vnc-native/<run> --probe connect-clipboard --probe keepalive

The fixture log shows exactly what the viewer sends (encodings, pixel format,
clipboard messages, KeepAlive probes, reconnects), so the reference behaviour
is measured with the same server and method as Taomni's native scenarios.
The password file is written under --report (gitignored) and deleted at exit.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import time
from pathlib import Path

from vnc_des import des_encrypt_block

OBFUSCATION_KEY = bytes([23, 82, 107, 6, 35, 78, 88, 7])


def password_file(path: Path, password: str) -> Path:
    key = bytes(int(f"{byte:08b}"[::-1], 2) for byte in OBFUSCATION_KEY)
    path.write_bytes(des_encrypt_block(key, password.encode("latin-1")[:8].ljust(8, b"\0")))
    return path


def control(port: int, command: str) -> str:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as conn:
        conn.sendall((command + "\n").encode())
        conn.shutdown(socket.SHUT_WR)
        return conn.recv(65536).decode().strip()


def events(log: str, since: float, kinds: tuple[str, ...] | None = None) -> list[dict]:
    out = []
    with open(log, encoding="utf-8") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event["t"] >= since and (kinds is None or event["type"] in kinds):
                out.append(event)
    return out


def wait_for(log: str, since: float, predicate, timeout: float) -> list[dict]:
    end = time.time() + timeout
    while time.time() < end:
        found = events(log, since)
        if predicate(found):
            return found
        time.sleep(0.2)
    return events(log, since)


def record(report: Path, probe: str, check: str, ok: bool, **details) -> None:
    line = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "client": "realvnc", "scenario": probe, "check": check, "ok": ok, **details}
    with open(report / "results.jsonl", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    print(("PASS " if ok else "INFO ") + json.dumps(line, ensure_ascii=False), flush=True)


# ── probes that need real OS input (interactive desktop) ─────────────
def keys_of(found: list[dict]) -> list[list]:
    return [[e["down"], e["keysym_hex"]] for e in found if e["type"] == "key"]


def viewer_window(proc: subprocess.Popen) -> int:
    """The RealVNC session window ("<address> (<desktop>) - RealVNC Viewer"); the
    launched executable may hand off to another process, so match by title."""
    import ctypes
    from ctypes import wintypes

    from vnc_native import user32

    end = time.time() + 10
    while time.time() < end:
        found: list[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def callback(hwnd, _):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            if user32.IsWindowVisible(hwnd) and buf.value.endswith("RealVNC Viewer") and "127.0.0.1" in buf.value:
                found.append(hwnd)
            return True

        user32.EnumWindows(callback, 0)
        if found:
            return found[0]
        time.sleep(0.3)
    return 0


def activate_viewer(hwnd: int) -> tuple[int, int, int, int]:
    import ctypes
    from ctypes import wintypes

    from vnc_native import bring_to_front, user32

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    bring_to_front(hwnd)
    cx, cy = (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2
    # RealVNC takes keyboard focus for the desktop on a click; against the
    # fixture server a left click is harmless.
    from vnc_native import mouse_click

    mouse_click(cx, cy)
    time.sleep(0.3)
    return rect.left, rect.top, rect.right, rect.bottom


def probe_special_keys(proc, args, log, ctl, report, since) -> None:
    from vnc_native import chord, tap

    hwnd = viewer_window(proc)
    activate_viewer(hwnd)
    for label, action in (("win", lambda: tap(0x5B)), ("alt-tab", lambda: chord(0x12, 0x09)),
                          ("prtscn", lambda: tap(0x2C))):
        start = time.perf_counter()
        action()
        time.sleep(1.0)
        import ctypes
        front = ctypes.windll.user32.GetForegroundWindow() == hwnd
        record(report, "special-keys", label, True, got=keys_of(events(log, start, ("key",))), foreground_viewer=front)
        if not front:
            tap(0x1B)
            activate_viewer(hwnd)
        time.sleep(0.3)


def probe_layouts(proc, args, log, ctl, report, since) -> None:
    from vnc_layouts import PROBES, layout_for

    hwnd = viewer_window(proc)
    for label, klid, action, want in PROBES:
        activate_viewer(hwnd)
        with layout_for(hwnd, klid) as layout:
            start = time.perf_counter()
            action()
            time.sleep(1.0)
        got = keys_of(events(log, start, ("key",)))
        record(report, "layouts", label, True, got=got, same_as_taomni_target=got == [[d, hex(k)] for d, k in want],
               layout=layout)


def set_clipboard(text: str) -> None:
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Set-Clipboard -Value $env:QA_CLIP"],
                   env={**os.environ, "QA_CLIP": text}, check=True, timeout=30)


def probe_clipboard_timing(proc, args, log, ctl, report, since) -> None:
    """Local clipboard change -> when does RealVNC send it (pointer re-enter, focus switch)?"""
    from vnc_native import user32

    hwnd = viewer_window(proc)
    left, top, right, bottom = activate_viewer(hwnd)
    for label in ("pointer-reenter", "focus-return"):
        text = f"rv-{label}-{int(time.time())}"
        if label == "pointer-reenter":
            user32.SetCursorPos(right + 60, (top + bottom) // 2)
            time.sleep(0.3)
            set_clipboard(text)
            start = time.perf_counter()
            user32.SetCursorPos((left + right) // 2, (top + bottom) // 2)
        else:
            shell = user32.FindWindowW("Shell_TrayWnd", None)
            user32.SetForegroundWindow(shell)
            time.sleep(0.5)
            set_clipboard(text)
            start = time.perf_counter()
            activate_viewer(hwnd)
        found = wait_for(log, start, lambda ev: any(text in (e.get("text") or "") for e in ev), 6)
        hit = next((e for e in found if text in (e.get("text") or "")), None)
        record(report, "clipboard-timing", label, True, sent=hit is not None,
               after_ms=round((hit["t"] - start) * 1000) if hit else None)


def probe_fullscreen_toolbar(proc, args, log, ctl, report, since) -> None:
    """RealVNC full-screen toolbar show/hide timing from screen pixels at the top centre."""
    from PIL import ImageChops, ImageGrab

    from vnc_native import user32

    hwnd = viewer_window(proc)
    activate_viewer(hwnd)
    width = user32.GetSystemMetrics(0)
    box = (width // 2 - 200, 0, width // 2 + 200, 50)
    user32.SetCursorPos(width // 2, 400)
    time.sleep(2.5)
    baseline = ImageGrab.grab(bbox=box)

    def changed() -> bool:
        diff = ImageChops.difference(ImageGrab.grab(bbox=box).convert("L"), baseline.convert("L"))
        return sum(1 for v in diff.getdata() if v > 40) > 800

    user32.SetCursorPos(width // 2, 1)
    start = time.time()
    shown = None
    while time.time() - start < 3:
        if changed():
            shown = time.time() - start
            break
        time.sleep(0.03)
    ImageGrab.grab(bbox=box).save(Path(args.report) / "rv-toolbar-shown.png")
    user32.SetCursorPos(width // 2, 400)
    left_at = time.time()
    hidden = None
    while time.time() - left_at < 6:
        if not changed():
            hidden = time.time() - left_at
            break
        time.sleep(0.03)
    record(report, "fullscreen-toolbar", "timing", shown is not None, show_after_s=round(shown, 2) if shown else None,
           hide_after_s=round(hidden, 2) if hidden else None)


OS_PROBES = {
    "special-keys": probe_special_keys,
    "layouts": probe_layouts,
    "clipboard-timing": probe_clipboard_timing,
    "fullscreen-toolbar": probe_fullscreen_toolbar,
}


def launch(args, extra: list[str]) -> subprocess.Popen:
    pw = password_file(Path(args.report) / "realvnc.pwd", os.environ[args.password_env])
    command = [args.viewer, f"-PasswordFile={pw}", "-WarnUnencrypted=0", *extra, f"127.0.0.1::{args.port}"]
    return subprocess.Popen(command)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--viewer", required=True)
    parser.add_argument("--port", type=int, default=5988)
    parser.add_argument("--password-env", required=True)
    parser.add_argument("--fixture-log", required=True)
    parser.add_argument("--fixture-control", type=int, required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--probe", action="append", required=True)
    parser.add_argument("--viewer-arg", action="append", default=[], help="extra RealVNC parameter, e.g. -Quality=Low")
    args = parser.parse_args()
    report = Path(args.report)
    report.mkdir(parents=True, exist_ok=True)
    log = args.fixture_log
    ctl = args.fixture_control
    marker = time.perf_counter()
    proc = launch(args, args.viewer_arg)
    try:
        found = wait_for(log, marker, lambda ev: any(e["type"] == "fbur" for e in ev), 60)
        init = next((e for e in found if e["type"] == "client_init"), None)
        encodings = next((e["encodings"] for e in found if e["type"] == "set_encodings"), [])
        formats = [e for e in found if e["type"] == "set_pixel_format"]
        record(report, "connect", "session", init is not None, shared=init and init["shared"], encodings=encodings,
               pixel_format=formats[-1] if formats else None,
               connect_to_first_request_ms=round((next(e["t"] for e in found if e["type"] == "fbur") - marker) * 1000)
               if any(e["type"] == "fbur" for e in found) else None)
        for probe in args.probe:
            since = time.perf_counter()
            if probe == "connect-clipboard":
                time.sleep(3)
                sent = events(log, marker, ("cut_text", "ext_clipboard"))
                record(report, probe, "clipboard-at-connect", True, messages=[{k: e.get(k) for k in ("type", "action", "length")} for e in sent])
                remote = f"remote-{int(time.time())}"
                control(ctl, f"cuttext {remote}")
                time.sleep(2)
                local = subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
                                       capture_output=True, text=True, timeout=30).stdout.strip()
                record(report, probe, "server-to-local", local == remote, local=local[:40])
            elif probe == "keepalive":
                control(ctl, "freeze")
                started = time.time()
                found = wait_for(log, since, lambda ev: any(e["type"] == "connect" for e in ev), 90)
                reconnect = next((e for e in found if e["type"] == "connect"), None)
                probes = [e for e in found if e["type"] == "fbur" and e["rect"] == [0, 0, 1, 1]]
                all_requests = [e for e in found if e["type"] == "fbur"]
                control(ctl, "thaw")
                record(report, probe, "hung-server", True, alive=proc.poll() is None,
                       reconnect_after_s=round(reconnect["t"] - since, 1) if reconnect else None,
                       probe_1x1=len(probes), requests_while_frozen=len(all_requests),
                       requests=[{"inc": e["incremental"], "rect": e["rect"], "at_s": round(e["t"] - since, 1)} for e in all_requests[:6]],
                       waited_s=round(time.time() - started, 1))
            elif probe == "drop":
                control(ctl, "drop")
                found = wait_for(log, since, lambda ev: any(e["type"] == "client_init" for e in ev), 60)
                again = next((e for e in found if e["type"] == "connect"), None)
                record(report, probe, "auto-reconnect", again is not None,
                       reconnect_after_s=round(again["t"] - since, 1) if again else None, alive=proc.poll() is None)
            elif probe == "hold":
                time.sleep(20)
            elif probe in OS_PROBES:
                OS_PROBES[probe](proc, args, log, ctl, report, since)
            else:
                record(report, probe, "unknown", False)
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        pwd = Path(args.report) / "realvnc.pwd"
        if pwd.exists():
            pwd.unlink()


if __name__ == "__main__":
    main()
