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


def session_windows() -> list[tuple[int, str]]:
    """Visible RealVNC session windows: "<address> (<desktop>) - RealVNC Viewer"
    (7.15) or "... - VNC Viewer" (7.0); the address book window has no address."""
    import ctypes
    from ctypes import wintypes

    from vnc_native import user32

    found: list[tuple[int, str]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if user32.IsWindowVisible(hwnd) and buf.value.endswith("VNC Viewer") and "127.0.0.1" in buf.value:
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(callback, 0)
    return found


def viewer_window(proc: subprocess.Popen, timeout: float = 10.0, connected: bool = False) -> int:
    """The session window; the launched executable may hand off to another
    process, so match by title. `connected` waits for the desktop name."""
    import vnc_native

    end = time.time() + timeout
    while time.time() < end:
        found = [(hwnd, title) for hwnd, title in session_windows() if not connected or " (" in title]
        if found:
            hwnd = found[0][0]
            vnc_native.TARGET_PIDS.add(vnc_native._window_pid(hwnd))
            return hwnd
        time.sleep(0.3)
    return 0


def activate_viewer(hwnd: int, click: bool = True) -> tuple[int, int, int, int]:
    import ctypes
    from ctypes import wintypes

    from vnc_native import bring_to_front, user32

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    bring_to_front(hwnd)
    cx, cy = (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2
    if click:
        # RealVNC takes keyboard focus for the desktop on a click; against the
        # fixture server a left click is harmless (never used on a live server).
        from vnc_native import mouse_click

        mouse_click(cx, cy)
    else:
        user32.SetCursorPos(cx, cy)
    time.sleep(0.3)
    return rect.left, rect.top, rect.right, rect.bottom


def probe_pointer_latency(proc, args, log, ctl, report, since) -> None:
    """VNC-PERF-005-A1: the same vnc_pointer_latency.py method as the Taomni
    scenario; moves only (no click, no key), so it is safe on a live server."""
    import sys

    hwnd = viewer_window(proc, timeout=90, connected=True)
    if not hwnd:
        record(report, "pointer-latency", "connect", False, reason="session window with a desktop name not found")
        return
    time.sleep(3)
    script = Path(__file__).with_name("vnc_pointer_latency.py")
    for run in range(args.latency_runs):
        left, top, right, bottom = activate_viewer(hwnd, click=False)
        import ctypes

        front = ctypes.windll.user32.GetForegroundWindow() == hwnd
        # A third into the client area, clear of the title bar.
        x, y = left + (right - left) // 3, top + 60 + (bottom - top - 60) // 3
        result = subprocess.run(
            [sys.executable, str(script), "--up-log", args.up_log, "--x", str(x), "--y", str(y), "--moves", "40",
             "--interval-ms", "200", "--size", str(args.pointer_size), "--label", f"realvnc-{run}",
             "--dump", str(Path(args.report) / "pointer-latency.jsonl")],
            capture_output=True, text=True, timeout=120,
        )
        line = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else result.stderr[-300:]
        record(report, "pointer-latency", f"run-{run}", "median_ms" in line, line=line, foreground_viewer=front)
        time.sleep(1.0)


def probe_special_keys(proc, args, log, ctl, report, since) -> None:
    """Same keys, same order and timing as vnc_native_scenarios.SPECIAL_KEY_PROBES."""
    import ctypes

    from vnc_native import dismiss_shell_surface, foreground_image
    from vnc_native_scenarios import SPECIAL_KEY_PROBES

    hwnd = viewer_window(proc)
    for label, action, want in SPECIAL_KEY_PROBES:
        activate_viewer(hwnd)
        if ctypes.windll.user32.GetForegroundWindow() != hwnd:
            record(report, "special-keys", label, False, reason="viewer not in front; key not sent")
            continue
        start = time.perf_counter()
        action()
        time.sleep(1.0)
        got = keys_of(events(log, start, ("key",)))
        front = ctypes.windll.user32.GetForegroundWindow() == hwnd
        record(report, "special-keys", label, True, got=got, foreground_viewer=front,
               local_surface=None if front else foreground_image(),
               remote_matches=got == [[d, hex(k)] for d, k in want])
        if not front:
            dismiss_shell_surface()
        time.sleep(0.3)


def probe_layouts(proc, args, log, ctl, report, since) -> None:
    from vnc_layouts import PROBES, layout_for, warm_up

    hwnd = viewer_window(proc)
    for label, klid, action, want in PROBES:
        activate_viewer(hwnd)
        with layout_for(hwnd, klid) as layout:
            warm_up()
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
            # The cursor stays inside the viewer, so only the focus changes.
            from vnc_native import bring_to_front

            bring_to_front(user32.FindWindowW("Shell_TrayWnd", None))
            time.sleep(0.5)
            away = user32.GetForegroundWindow() != hwnd
            set_clipboard(text)
            start = time.perf_counter()
            bring_to_front(hwnd)
        found = wait_for(log, start, lambda ev: any(text in (e.get("text") or "") for e in ev), 6)
        hit = next((e for e in found if text in (e.get("text") or "")), None)
        record(report, "clipboard-timing", label, True, sent=hit is not None,
               after_ms=round((hit["t"] - start) * 1000) if hit else None,
               left_window=away if label == "focus-return" else None)


def probe_unicode_clipboard(proc, args, log, ctl, report, since) -> None:
    """VNC-CLIP-001-A2 reference: Chinese text both ways (legacy or Extended clipboard)."""
    from vnc_native import user32

    hwnd = viewer_window(proc)
    left, top, right, bottom = activate_viewer(hwnd)
    text = "中文剪贴板 ✓"
    user32.SetCursorPos(right + 60, (top + bottom) // 2)
    time.sleep(0.3)
    set_clipboard(text)
    start = time.perf_counter()
    user32.SetCursorPos((left + right) // 2, (top + bottom) // 2)
    found = wait_for(log, start, lambda ev: any(e["type"] in ("cut_text", "ext_clipboard") for e in ev), 6)
    sent = [{k: e.get(k) for k in ("type", "action", "formats", "text")} for e in found
            if e["type"] in ("cut_text", "ext_clipboard")]
    record(report, "unicode-clipboard", "client-to-server", any(e.get("text") == text for e in sent), sent=sent[:4])
    remote = "服务器文本 ok"
    control(ctl, f"extclip {remote}")
    time.sleep(2.5)
    local = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                           capture_output=True, timeout=30).stdout.decode("utf-8", "replace").strip()
    record(report, "unicode-clipboard", "server-to-client", local == remote, local=local[:40])


def probe_fullscreen_toolbar(proc, args, log, ctl, report, since) -> None:
    """RealVNC full-screen toolbar show/hide timing from screen pixels at the top
    centre (vnc_native.toolbar_timing, the method the Taomni scenario uses too)."""
    from PIL import ImageGrab

    from vnc_native import toolbar_timing, user32

    hwnd = viewer_window(proc)
    activate_viewer(hwnd)
    width = user32.GetSystemMetrics(0)
    box = (width // 2 - 200, 0, width // 2 + 200, 50)
    for attempt in range(3):
        timing = toolbar_timing(box, enter=(width // 2, 0), leave=(width // 2, 400))
        record(report, "fullscreen-toolbar", f"timing-{attempt}", timing["show_start_s"] is not None, **timing)
    from vnc_native import toolbar_zones

    zones = toolbar_zones(box, width // 2)
    record(report, "fullscreen-toolbar", "zones", zones["starts_hiding_at_y"] is not None, **zones)
    # The toolbar itself (pointer resting on it).
    user32.SetCursorPos(width // 2, 0)
    time.sleep(1.0)
    ImageGrab.grab(bbox=(width // 2 - 300, 0, width // 2 + 300, 80)).save(Path(args.report) / "rv-toolbar-shown.png")
    user32.SetCursorPos(width // 2, 400)


OS_PROBES = {
    "special-keys": probe_special_keys,
    "layouts": probe_layouts,
    "clipboard-timing": probe_clipboard_timing,
    "fullscreen-toolbar": probe_fullscreen_toolbar,
    "pointer-latency": probe_pointer_latency,
    "unicode-clipboard": probe_unicode_clipboard,
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
    parser.add_argument("--fixture-log", help="omit for a live server behind vnc_burst_proxy.py (pointer-latency only)")
    parser.add_argument("--fixture-control", type=int)
    parser.add_argument("--report", required=True)
    parser.add_argument("--probe", action="append", required=True)
    parser.add_argument("--viewer-arg", action="append", default=[], help="extra RealVNC parameter, e.g. -Quality=Low")
    parser.add_argument("--up-log", help="vnc_burst_proxy.py --up-log file (pointer-latency)")
    parser.add_argument("--pointer-size", type=int, default=6)
    parser.add_argument("--latency-runs", type=int, default=3)
    args = parser.parse_args()
    report = Path(args.report)
    report.mkdir(parents=True, exist_ok=True)
    log = args.fixture_log
    ctl = args.fixture_control
    marker = time.perf_counter()
    before = {hwnd for hwnd, _ in session_windows()}
    proc = launch(args, args.viewer_arg)
    try:
        if not log:
            for probe in args.probe:
                if probe != "pointer-latency":
                    record(report, probe, "unsupported-without-fixture", False)
                    continue
                probe_pointer_latency(proc, args, log, ctl, report, time.perf_counter())
            return
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
        close_new_sessions(before)
        pwd = Path(args.report) / "realvnc.pwd"
        if pwd.exists():
            pwd.unlink()


def close_new_sessions(before: set[int]) -> None:
    """Close session windows this run opened. A viewer that was already running
    (the user's own) may host them, so windows get WM_CLOSE, never a kill."""
    import ctypes

    WM_CLOSE = 0x0010
    for _ in range(20):
        mine = [hwnd for hwnd, _ in session_windows() if hwnd not in before]
        if not mine:
            return
        for hwnd in mine:
            ctypes.windll.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
