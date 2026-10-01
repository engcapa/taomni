"""Scenario checks for vnc_native.py. Each scenario records PASS/FAIL lines.

Fixture scenarios expect vnc_fixture_server.py with --log and --control-port;
vnc_native.py passes them as --fixture-log / --fixture-control.
"""

from __future__ import annotations

import json
import socket
import subprocess
import time

from vnc_native import App, chord, dismiss_shell_surface, foreground_image, mouse_click, mouse_wheel, tap, user32

VK_F8, VK_ESCAPE, VK_TAB, VK_MENU, VK_LWIN, VK_SNAPSHOT = 0x77, 0x1B, 0x09, 0x12, 0x5B, 0x2C


def press(app: App, vk: int, combo: str) -> str:
    """A real key press when an interactive desktop exists (the WebView sees
    it through the OS keyboard path), otherwise the WebDriver equivalent."""
    if app.os_input:
        app.activate()
        tap(vk)
        return "os-sendinput"
    app.key(combo)
    return "webdriver-actions"


# ── fixture helpers ───────────────────────────────────────────────────
def control(args, command: str) -> str:
    with socket.create_connection(("127.0.0.1", args.fixture_control), timeout=5) as conn:
        conn.sendall((command + "\n").encode())
        conn.shutdown(socket.SHUT_WR)
        return conn.recv(65536).decode().strip()


def events_since(args, since: float, kinds: tuple[str, ...] | None = None) -> list[dict]:
    out = []
    with open(args.fixture_log, encoding="utf-8") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event["t"] >= since and (kinds is None or event["type"] in kinds):
                out.append(event)
    return out


def current_conn(args) -> int:
    inits = events_since(args, 0, ("client_init",))
    return inits[-1]["conn"] if inits else -1


def now() -> float:
    return time.perf_counter()


def wait_events(args, since: float, predicate, timeout: float = 10.0) -> list[dict]:
    end = time.time() + timeout
    while time.time() < end:
        events = events_since(args, since)
        if predicate(events):
            return events
        time.sleep(0.2)
    return events_since(args, since)


def keys(events: list[dict]) -> list[tuple[bool, int]]:
    return [(e["down"], e["keysym"]) for e in events if e["type"] == "key"]


def set_local_clipboard(text: str) -> None:
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Set-Clipboard -Value $env:QA_CLIP"],
                   env={**__import__("os").environ, "QA_CLIP": text}, check=True, timeout=30)


def get_local_clipboard() -> str:
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                             "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                            capture_output=True, timeout=30)
    return result.stdout.decode("utf-8", "replace").strip()


def canvas_pixel(app: App, x: int, y: int) -> list[int]:
    return app.js(
        "const c = document.querySelector('[data-testid=\"vnc-canvas\"]');"
        f"return Array.from(c.getContext('2d').getImageData({x}, {y}, 1, 1).data);"
    )


def fixture_pixel(width: int, height: int, x: int, y: int) -> list[int]:
    """Background pattern of vnc_fixture_server.Scene outside its panels."""
    if x % 32 == 0 or y % 32 == 0:
        return [40, 40, 40]
    return [x * 255 // max(1, width - 1), y * 255 // max(1, height - 1), 96]


def open_menu(app: App) -> None:
    app.focus_canvas()
    app.key("F8")
    try:
        app.wait_js("!!document.querySelector('[data-testid=\"vnc-menu-send-cad\"]')", timeout=5)
    except TimeoutError as error:
        state = app.js("return [document.hasFocus(), document.activeElement?.dataset?.testid ?? document.activeElement?.tagName];")
        raise TimeoutError(f"menu did not open; foreground_ours={app.ours_in_front()} focus={state}") from error


def menu_pick(app: App, parent: str | None, item: str) -> None:
    if parent:
        app.js(
            f"document.querySelector('[data-testid=\"{parent}\"]').dispatchEvent(new MouseEvent('mouseover', {{bubbles: true}}));"
            f"document.querySelector('[data-testid=\"{parent}\"]').dispatchEvent(new MouseEvent('mouseenter', {{bubbles: false}}));"
            "return true;"
        )
        app.wait_js(f"!!document.querySelector('[data-testid=\"{item}\"]')", timeout=5)
    app.click_testid(item)


# ── scenarios ─────────────────────────────────────────────────────────
def scenario_hold(app: App, args) -> None:
    """Keep the connected session idle for --hold-seconds (traffic measured by the proxy)."""
    time.sleep(args.hold_seconds)
    app.run.record("hold", "session-info", True, info=session_info(app))


def scenario_probe(app: App, args) -> None:
    """Harness self-check: which process/window owns the foreground."""
    import ctypes
    from ctypes import wintypes

    from vnc_native import foreground_pid, window_of_pid

    app.activate()
    fg = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(fg, buf, 256)
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, foreground_pid())
    image = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(1024)
    kernel32.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size))
    app.run.record("probe", "foreground", app.ours_in_front(), app_pid=app.pid, fg_pid=foreground_pid(),
                   fg_image=image.value[-60:], fg_title=buf.value[:40], our_hwnd=window_of_pid(app.pid), fg_hwnd=fg)
def scenario_desktop_size(app: App, args) -> None:
    """VNC-PERF-002-A3: server-driven DesktopSize repaints the new surface."""
    for width, height in ((1024, 640), (1680, 1050)):
        since = now()
        control(args, f"resize {width} {height}")
        app.wait_js(f"document.querySelector('[data-testid=\"vnc-canvas\"]').width === {width}", timeout=10)
        time.sleep(1.0)
        samples = [(5, 5), (width - 9, height // 2 + 3), (width // 2 + 7, 13)]
        mismatches = []
        for x, y in samples:
            got = canvas_pixel(app, x, y)[:3]
            want = fixture_pixel(width, height, x, y)
            if any(abs(a - b) > 2 for a, b in zip(got, want)):
                mismatches.append({"at": [x, y], "got": got, "want": want})
        events = events_since(args, since)
        resized = [e for e in events if e["type"] == "desktop_size"]
        requests = [e for e in events if e["type"] == "fbur"]
        app.screenshot(f"desktop-size-{width}x{height}")
        app.run.record("desktop-size", f"{width}x{height}", not mismatches and bool(resized),
                       mismatches=mismatches, desktop_size_events=len(resized), requests_after=len(requests),
                       store=app.js("return document.querySelector('[data-testid=\"vnc-canvas\"]').height;"))


def scenario_cad(app: App, args) -> None:
    """VNC-INPUT-002-A3: toolbar Ctrl+Alt+Del reaches the remote in order."""
    since = now()
    app.click_testid("vnc-send-cad")
    events = wait_events(args, since, lambda ev: len(keys(ev)) >= 6, timeout=5)
    got = keys(events)
    want = [(True, 0xffe3), (True, 0xffe9), (True, 0xffff), (False, 0xffff), (False, 0xffe9), (False, 0xffe3)]
    app.run.record("cad", "toolbar-sequence", got == want, got=[[d, hex(k)] for d, k in got])
    since = now()
    open_menu(app)
    menu_pick(app, None, "vnc-menu-send-cad")
    events = wait_events(args, since, lambda ev: len(keys(ev)) >= 6, timeout=5)
    got = keys(events)
    app.run.record("cad", "menu-sequence-no-f8", got == want, got=[[d, hex(k)] for d, k in got])


def scenario_mouse(app: App, args) -> None:
    """VNC-INPUT-001-A1/A2: right/middle click and one wheel notch per press/release."""
    app.focus_canvas()
    x, y = app.canvas_center()
    buttons = {"right": 2, "middle": 1}
    for button, mask in (("right", 4), ("middle", 2)):
        since = now()
        if app.os_input:
            mouse_click(x, y, button)
        else:
            app.click_canvas(buttons[button])
        events = wait_events(args, since, lambda ev: any(e["type"] == "pointer" and e["mask"] == mask for e in ev), 3)
        masks = [e["mask"] for e in events if e["type"] == "pointer"]
        pressed_at = next((e["t"] for e in events if e["type"] == "pointer" and e["mask"] == mask), None)
        app.run.record("mouse", f"{button}-click", mask in masks and masks[-1] == 0,
                       masks=masks, press_after_ms=round((pressed_at - since) * 1000, 1) if pressed_at else None)
        app.key("Escape") if app.exists("vnc-menu-send-cad") else None
    for label, delta, horizontal, mask in (("wheel-down", -120, False, 0x10), ("wheel-up", 120, False, 0x08),
                                           ("wheel-right", 120, True, 0x40)):
        since = now()
        if app.os_input:
            mouse_wheel(x, y, delta, horizontal)
        elif horizontal:
            app.wheel_canvas(delta_x=delta)
        else:
            app.wheel_canvas(delta_y=-delta)
        events = wait_events(args, since, lambda ev: any(e["type"] == "pointer" and e["mask"] & mask for e in ev), 3)
        time.sleep(0.3)
        masks = [e["mask"] for e in events_since(args, since, ("pointer",))]
        presses = sum(1 for i, m in enumerate(masks) if m & mask and (i == 0 or not masks[i - 1] & mask))
        app.run.record("mouse", label, presses == 1 and bool(masks) and (masks[-1] & mask) == 0, masks=masks)
    if app.os_input:
        # VNC-PERF-005-A2: a left-button drag keeps the button bit on every
        # move, ends with one release and sends no duplicate events.
        from vnc_native import INPUT, INPUT_MOUSE, MOUSEINPUT, _INPUTUNION, send_inputs

        def button(flag: int) -> None:
            send_inputs(INPUT(INPUT_MOUSE, _INPUTUNION(mi=MOUSEINPUT(0, 0, 0, flag, 0, 0))))

        user32.SetCursorPos(x, y)
        time.sleep(0.2)
        since = now()
        button(0x2)
        for step in range(1, 11):
            time.sleep(0.03)
            user32.SetCursorPos(x + step * 6, y + step * 3)
        time.sleep(0.05)
        button(0x4)
        time.sleep(0.5)
        drag = [(e["x"], e["y"], e["mask"]) for e in events_since(args, since, ("pointer",))]
        duplicates = sum(1 for a, b in zip(drag, drag[1:]) if a == b)
        held = [m for _, _, m in drag[1:-1]]
        app.run.record("mouse", "left-drag", bool(drag) and drag[0][2] == 1 and drag[-1][2] == 0
                       and all(m == 1 for m in held) and duplicates == 0 and len(drag) >= 6,
                       events=len(drag), duplicates=duplicates, first=drag[:1], last=drag[-1:])


def reenter_pointer(app: App) -> float:
    """Leave the remote desktop and come back (the RealVNC clipboard sync point).
    Returns the perf_counter stamp of the move back in (what RealVNC is timed from)."""
    if app.os_input:
        x, y, w, h = app.canvas_rect_screen()
        user32.SetCursorPos(x + w + 40, y + h // 2)
        time.sleep(0.3)
        entered = now()
        user32.SetCursorPos(x + w // 2, y + h // 2)
        return entered
    app.move_viewport(2, 2)
    time.sleep(0.3)
    entered = now()
    app.move_canvas(0, 0)
    return entered


def scenario_menu_key(app: App, args) -> None:
    """VNC-INPUT-002-A1: F8 opens the menu without reaching the remote."""
    since = now()
    open_menu(app)
    escapes = 0
    while app.exists("vnc-menu-send-cad") and escapes < 3:
        # Esc closes an open submenu first (the pointer may rest on one), then the menu.
        app.key("Escape")
        escapes += 1
        time.sleep(0.3)
    time.sleep(0.3)
    events = events_since(args, since, ("key",))
    closed = not app.exists("vnc-menu-send-cad")
    app.run.record("menu-key", "f8-local-only", closed and not events, remote_keys=len(events), menu_closed_by_esc=closed, escapes=escapes,
                   keys=[[e["down"], e["keysym_hex"]] for e in events])
    if not closed:
        app.js("document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); return true;")


def scenario_quality(app: App, args) -> None:
    """VNC-PERF-004-A3: picture quality switches in session."""
    for preset, item in (("low", "vnc-quality-low"), ("medium", "vnc-quality-medium"), ("high", "vnc-quality-high")):
        since = now()
        open_menu(app)
        menu_pick(app, "vnc-menu-quality", item)
        events = wait_events(args, since, lambda ev: any(e["type"] == "set_encodings" for e in ev)
                             and any(e["type"] == "fbur" and not e["incremental"] for e in ev), 8)
        encodings = next((e["encodings"] for e in events if e["type"] == "set_encodings"), [])
        formats = [e for e in events if e["type"] == "set_pixel_format"]
        time.sleep(2.5)
        info = session_info(app)
        app.run.record("quality", preset, bool(encodings), encodings=encodings[:8],
                       pixel_format_changes=[{k: f[k] for k in ("bpp", "depth", "max")} for f in formats],
                       fixture=json.loads(control(args, "stats") or "[]")[-1:], session_info=info)


def session_info(app: App) -> dict:
    open_menu(app)
    menu_pick(app, None, "vnc-menu-info")
    app.wait_js("!!document.querySelector('[data-testid=\"vnc-session-info\"]')", timeout=5)
    time.sleep(1.2)
    rows = app.js(
        "return Array.from(document.querySelectorAll('[data-testid=\"vnc-session-info\"] dd'))"
        ".map(d => [d.dataset.testid, d.textContent]);"
    )
    app.click_testid("vnc-session-info-ok")
    return {key.replace("vnc-info-", ""): value for key, value in rows}


def scenario_clipboard(app: App, args) -> None:
    """VNC-CLIP-001-A1: connect / focus / copy / remote-copy timing."""
    # The QA window must be in front, or the cursor re-enters whatever covers it.
    app.focus_canvas()
    conn = current_conn(args)
    events = [e for e in events_since(args, 0, ("cut_text", "ext_clipboard")) if e["conn"] == conn]
    provided = [e for e in events if e["type"] == "cut_text" or e.get("action") == "provide"]
    app.run.record("clipboard", "no-push-on-connect", not provided, events=provided[:3])
    # A local change reaches the server when the pointer re-enters the desktop.
    text = f"local-{int(time.time())}"
    set_local_clipboard(text)
    since = reenter_pointer(app)
    events = wait_events(args, since, lambda ev: any(text in (e.get("text") or "") for e in ev), 5)
    hit = next((e for e in events if text in (e.get("text") or "")), None)
    app.run.record("clipboard", "pointer-enter-sends-local-change", hit is not None,
                   after_ms=round((hit["t"] - since) * 1000) if hit else None, via=hit and hit["type"])
    # ... and when the window gets focus back (RealVNC: sent on focus return).
    if app.os_input:
        from vnc_native import bring_to_front

        bring_to_front(user32.FindWindowW("Shell_TrayWnd", None))
        time.sleep(0.5)
        away = not app.ours_in_front()
        text = f"focus-{int(time.time())}"
        set_local_clipboard(text)
        since = now()
        app.activate()
        events = wait_events(args, since, lambda ev: any(text in (e.get("text") or "") for e in ev), 5)
        hit = next((e for e in events if text in (e.get("text") or "")), None)
        app.run.record("clipboard", "focus-return-sends-local-change", away and hit is not None, left_window=away,
                       after_ms=round((hit["t"] - since) * 1000) if hit else None, via=hit and hit["type"])
    # Server clipboard lands locally and is not echoed back (grace time).
    remote = f"remote-{int(time.time())}"
    since = now()
    control(args, f"cuttext {remote}")
    end = time.time() + 5
    got = ""
    while time.time() < end:
        got = get_local_clipboard()
        if got == remote:
            break
        time.sleep(0.3)
    reenter_pointer(app)
    time.sleep(1.5)
    echoes = [e for e in events_since(args, since, ("cut_text", "ext_clipboard")) if remote in (e.get("text") or "")]
    app.run.record("clipboard", "server-to-local-no-echo", got == remote and not echoes, local=got[:40], echoes=len(echoes))


def scenario_clipboard_keys(app: App, args) -> None:
    """VNC-CLIP-001: Send Clipboard as Keystrokes types the text."""
    set_local_clipboard("Ab1\n")
    since = now()
    open_menu(app)
    menu_pick(app, None, "vnc-menu-send-clipboard-keys")
    events = wait_events(args, since, lambda ev: len(keys(ev)) >= 8, 5)
    got = [k for d, k in keys(events) if d]
    app.run.record("clipboard-keys", "typed", got == [0x41, 0x62, 0x31, 0xff0d], got=[hex(k) for k in got])


def scenario_ext_clipboard(app: App, args) -> None:
    """VNC-CLIP-001-A2: ExtendedClipboard with Chinese text both ways."""
    # Unique per run: a clipboard that already holds the text when the session
    # connects is the baseline, which is correctly not sent again.
    text = f"中文剪贴板 ✓ {time.strftime('%H%M%S')}"
    app.session.install_console_hook()
    # The QA window must be in front, or the cursor re-enters whatever covers it.
    app.focus_canvas()
    set_local_clipboard(text)
    readback = get_local_clipboard()
    since = reenter_pointer(app)
    events = wait_events(args, since, lambda ev: any(e.get("action") == "provide" for e in ev), 6)
    provided = next((e for e in events if e.get("action") == "provide"), None)
    notify = [e for e in events if e.get("action") == "notify"]
    clip_log = [" ".join(e.get("args", []))[:160] for e in app.session.console_entries() if "vnc.clip" in " ".join(e.get("args", []))]
    app.run.record("ext-clipboard", "client-to-server", bool(provided) and provided.get("text") == text,
                   notify=len(notify), text=provided and provided.get("text"), local_readback=readback, console=clip_log[-6:])
    remote = "服务器文本 ok"
    control(args, f"extclip {remote}")
    end = time.time() + 6
    got = ""
    while time.time() < end:
        got = get_local_clipboard()
        if got == remote:
            break
        time.sleep(0.3)
    app.run.record("ext-clipboard", "server-to-client", got == remote, local=got)
    if app.os_input:
        # Rich text: Ctrl+V on the desktop provides HTML next to the text.
        subprocess.run(["powershell.exe", "-NoProfile", "-Command", "Set-Clipboard -Value $env:QA_CLIP -AsHtml"],
                       env={**__import__("os").environ, "QA_CLIP": "<b>粗体</b> 富文本"}, check=True, timeout=30)
        time.sleep(1.2)  # past the server clipboard grace time
        app.focus_canvas()
        since = now()
        chord(0x11, 0x56)
        # The remote V follows the provide after PASTE_KEY_DELAY_MS.
        events = wait_events(args, since, lambda ev: any(e.get("action") == "provide" for e in ev)
                             and (True, 0x76) in keys(ev), 6)
        provided = next((e for e in events if e.get("action") == "provide"), None)
        typed = [k for k in keys(events_since(args, since, ("key",)))]
        app.run.record("ext-clipboard", "rich-text-paste", bool(provided) and bool(provided["formats"] & 0x4)
                       and (True, 0x76) in typed, formats=provided and provided["formats"],
                       text=provided and provided.get("text"), keys=[[d, hex(k)] for d, k in typed])


def wait_connected(app: App, timeout: float) -> tuple[bool, int]:
    """Wait for pixels again, answering the per-attempt unencrypted warning
    (shown again on every reconnect, as in RealVNC). Returns (ok, prompts)."""
    end = time.time() + timeout
    prompts = 0
    while time.time() < end:
        if app.exists("vnc-unencrypted-continue"):
            app.click_testid("vnc-unencrypted-continue")
            prompts += 1
            time.sleep(0.3)
            continue
        if app.connected() and not app.js("return !!document.querySelector('[data-testid^=\"vnc-overlay\"]');"):
            return True, prompts
        time.sleep(0.2)
    return False, prompts


def wait_overlay_answering(app: App, testid: str, timeout: float) -> tuple[bool, int]:
    end = time.time() + timeout
    prompts = 0
    while time.time() < end:
        if app.exists(testid):
            return True, prompts
        if testid != "vnc-overlay-unencrypted" and app.exists("vnc-unencrypted-continue"):
            app.click_testid("vnc-unencrypted-continue")
            prompts += 1
        time.sleep(0.2)
    return False, prompts


def wait_overlay(app: App, testid: str, timeout: float) -> bool:
    try:
        app.wait_js(f"!!document.querySelector('[data-testid=\"{testid}\"]')", timeout=timeout)
        return True
    except TimeoutError:
        return False


def overlay_text(app: App) -> str:
    return app.js("return Array.from(document.querySelectorAll('[data-testid^=\"vnc-overlay\"]')).map(e => e.textContent).join(' | ');")


def scenario_drop(app: App, args) -> None:
    """VNC-SESS-003-A2: network drop -> automatic reconnect."""
    started = time.time()
    control(args, "drop")
    seen = wait_overlay(app, "vnc-overlay-reconnecting", 5)
    text = overlay_text(app)
    app.screenshot("drop-reconnecting")
    ok, prompts = wait_connected(app, 30)
    app.run.record("drop", "auto-reconnect", seen and ok, overlay=text[:200], unencrypted_prompts=prompts,
                   reconnected_after_s=round(time.time() - started, 1))


def scenario_keepalive(app: App, args) -> None:
    """VNC-SESS-003-A2: a hung server is detected by KeepAlive (30 + 30 s)."""
    started = time.time()
    since = now()
    control(args, "freeze")
    seen = wait_overlay(app, "vnc-overlay-reconnecting", 75)
    detected = time.time() - started
    text = overlay_text(app)
    app.screenshot("keepalive-lost")
    probes = [e for e in events_since(args, since, ("fbur",)) if e["rect"] == [0, 0, 1, 1] and not e["incremental"]]
    control(args, "thaw")
    ok, _ = wait_connected(app, 40)
    app.run.record("keepalive", "hung-server-detected", ok and seen and 55 <= detected <= 75 and bool(probes),
                   detected_after_s=round(detected, 1), probes=len(probes), overlay=text[:200])


def scenario_auth_fail(app: App, args) -> None:
    """VNC-SESS-003-A2: failed authentication shows the in-session form."""
    control(args, "reject-auth on")
    control(args, "drop")
    seen, prompts = wait_overlay_answering(app, "vnc-overlay-auth", 25)
    text = overlay_text(app)
    app.screenshot("auth-failed")
    control(args, "reject-auth off")
    password = __import__("os").environ.get(args.password_env or "", "")
    app.session.fill("[data-testid='vnc-auth-password']", password)
    app.click_testid("vnc-auth-ok")
    ok, more = wait_connected(app, 25)
    app.run.record("auth-fail", "form-then-reconnect", seen and ok, overlay=text[:200], unencrypted_prompts=prompts + more)


def scenario_stop(app: App, args) -> None:
    """VNC-SESS-003-A2: Stop during a slow authentication closes the attempt."""
    control(args, "auth-delay 20000")
    since = now()
    control(args, "drop")
    wait_overlay(app, "vnc-overlay-connecting", 15)
    time.sleep(1.5)
    if app.exists("vnc-unencrypted-continue"):
        app.click_testid("vnc-unencrypted-continue")
        wait_overlay(app, "vnc-overlay-connecting", 10)
        time.sleep(1.0)
    clicked = now()
    app.click_testid("vnc-connect-stop")
    stopped = wait_overlay(app, "vnc-overlay-disconnected", 3)
    closed = wait_events(args, clicked, lambda ev: any(e["type"] == "disconnect" for e in ev), 5)
    close_event = next((e for e in closed if e["type"] == "disconnect"), None)
    text = overlay_text(app)
    app.screenshot("stopped")
    time.sleep(3)
    reconnects = [e for e in events_since(args, clicked, ("connect",))]
    control(args, "auth-delay 0")
    app.run.record("stop", "stop-closes-attempt", stopped and close_event is not None and not reconnects,
                   socket_closed_after_ms=round((close_event["t"] - clicked) * 1000) if close_event else None,
                   later_connects=len(reconnects), overlay=text[:160])
    app.click_testid("vnc-reconnect")
    wait_connected(app, 20)


def native_window_at(x: int, y: int) -> str:
    import ctypes
    from ctypes import wintypes

    user32.WindowFromPoint.restype = wintypes.HWND
    user32.WindowFromPoint.argtypes = [wintypes.POINT]
    buf = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(user32.WindowFromPoint(wintypes.POINT(x, y)), buf, 128)
    return buf.value


def scenario_fullscreen(app: App, args) -> None:
    """VNC-VIEW-002-A1/A2: screen-level full screen, Esc to the remote, toolbar."""
    from vnc_native import window_of_pid

    hwnd = window_of_pid(app.pid)
    # Start from a maximized window: leaving full screen must bring it back.
    if not user32.IsZoomed(hwnd):
        app.click_testid("window-max")
        time.sleep(1.0)
    was_maximized = bool(user32.IsZoomed(hwnd))
    app.click_testid("vnc-fullscreen")
    app.wait_js("document.querySelector('[data-testid=\"vnc-panel\"]').dataset.vncFullscreen === 'true'", timeout=5)
    time.sleep(1.5)
    screen_w = user32.GetSystemMetrics(0)
    size = app.js("return [window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio];")
    app.screenshot("fullscreen")
    app.run.record("fullscreen", "covers-screen", abs(size[0] - screen_w) <= 2, viewport=size, screen_width=screen_w,
                   started_maximized=was_maximized)
    # Nothing native may sit over the WebView at the top edge (Tauri's resize
    # border window would take the pointer there).
    edge = {y: native_window_at(screen_w // 2, y) for y in (0, 1, 2, 3, 6)}
    app.run.record("fullscreen", "top-edge-reaches-webview",
                   all(name == "Chrome_RenderWidgetHostHWND" for name in edge.values()), windows=edge)
    app.focus_canvas()
    since = now()
    via = press(app, VK_ESCAPE, "Escape")
    time.sleep(0.6)
    still = app.dataset("vncFullscreen") == "true"
    got = keys(events_since(args, since, ("key",)))
    app.run.record("fullscreen", "esc-goes-to-remote", still and got == [(True, 0xff1b), (False, 0xff1b)],
                   keys=[[d, hex(k)] for d, k in got], input=via)
    since = now()
    press(app, VK_F8, "F8")
    menu = wait_overlay(app, "vnc-menu-send-cad", 3)
    press(app, VK_ESCAPE, "Escape")
    time.sleep(0.4)
    closed = not app.exists("vnc-menu-send-cad")
    focus = app.js("return document.activeElement?.dataset?.testid ?? document.activeElement?.tagName;")
    remote = keys(events_since(args, since, ("key",)))
    app.run.record("fullscreen", "f8-menu", menu and closed and not remote and focus == "vnc-canvas",
                   menu_opened=menu, esc_closed=closed, focus_after=focus, remote_keys=[[d, hex(k)] for d, k in remote],
                   input=via)
    # Toolbar: top edge shows it, leaving hides it after ~1.5 s.
    view_w = app.js("return window.innerWidth;")
    top_chain = app.js(
        "let e = document.elementFromPoint(window.innerWidth / 2, 1); const out = [];"
        "while (e && out.length < 6) { const cs = getComputedStyle(e);"
        " out.push([e.dataset?.testid || e.tagName, (e.className || '').toString().slice(0, 60), cs.position, cs.zIndex,"
        " Math.round(e.getBoundingClientRect().height)]); e = e.parentElement; } return out;"
    )
    app.move_viewport(view_w // 2, 200)
    time.sleep(0.3)
    if app.os_input:
        user32.SetCursorPos(screen_w // 2, 1)
    else:
        app.move_viewport(view_w // 2, 1)
    shown_at = time.time()
    shown = None
    while time.time() - shown_at < 2:
        if app.js("return document.querySelector('[data-testid=\"vnc-fullscreen-toolbar\"]')?.dataset.visible === 'true';"):
            shown = time.time() - shown_at
            break
        time.sleep(0.05)
    app.screenshot("fullscreen-toolbar")
    if app.os_input:
        user32.SetCursorPos(screen_w // 2, 400)
    else:
        app.move_viewport(view_w // 2, 400)
    left_at = time.time()
    hidden_after = None
    while time.time() - left_at < 4:
        if app.js("return document.querySelector('[data-testid=\"vnc-fullscreen-toolbar\"]')?.dataset.visible === 'false';"):
            hidden_after = time.time() - left_at
            break
        time.sleep(0.05)
    app.run.record("fullscreen", "toolbar-autohide", shown is not None and hidden_after is not None,
                   show_after_s=round(shown, 2) if shown is not None else None, top_edge_element=top_chain,
                   hide_after_s=round(hidden_after, 2) if hidden_after else None)
    if app.os_input:
        # Same screen-pixel method as vnc_realvnc_probe.py fullscreen-toolbar.
        from vnc_native import toolbar_timing, toolbar_zones

        box = (screen_w // 2 - 200, 0, screen_w // 2 + 200, 50)
        for attempt in range(3):
            timing = toolbar_timing(box, enter=(screen_w // 2, 0), leave=(screen_w // 2, 400))
            app.run.record("fullscreen", f"toolbar-pixels-{attempt}", timing["show_start_s"] is not None,
                           **{k: v for k, v in timing.items() if not k.endswith("_samples")})
        zones = toolbar_zones(box, screen_w // 2)
        app.run.record("fullscreen", "toolbar-zones", zones["starts_hiding_at_y"] is not None, **zones)
    app.click_testid("vnc-fs-exit")
    app.wait_js("document.querySelector('[data-testid=\"vnc-panel\"]').dataset.vncFullscreen === 'false'", timeout=5)
    time.sleep(1.0)
    size = app.js("return [window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio];")
    maximized = bool(user32.IsZoomed(hwnd))
    resizable = bool(user32.GetWindowLongW(hwnd, -16) & 0x00040000)  # WS_THICKFRAME
    app.run.record("fullscreen", "exit-restores-window", maximized == was_maximized and resizable, viewport=size,
                   maximized=maximized, resizable=resizable)
    if maximized:
        app.click_testid("window-max")
        time.sleep(0.8)


SPECIAL_KEY_PROBES = (
    ("win", lambda: tap(VK_LWIN), [(True, 0xffeb), (False, 0xffeb)]),
    ("alt-tab", lambda: chord(VK_MENU, VK_TAB), [(True, 0xffe9), (True, 0xff09), (False, 0xff09), (False, 0xffe9)]),
    ("alt-esc", lambda: chord(VK_MENU, VK_ESCAPE), [(True, 0xffe9), (True, 0xff1b), (False, 0xff1b), (False, 0xffe9)]),
    ("ctrl-esc", lambda: chord(0x11, VK_ESCAPE), [(True, 0xffe3), (True, 0xff1b), (False, 0xff1b), (False, 0xffe3)]),
    ("prtscn", lambda: tap(VK_SNAPSHOT), [(True, 0xff61), (False, 0xff61)]),
)


def hook_status(app: App) -> dict:
    """Panel capture state plus the backend hook counters (vnc_special_key_capture_status)."""
    app.js("window.__qaHook = null; window.__TAURI_INTERNALS__.invoke('vnc_special_key_capture_status')"
           ".then(s => { window.__qaHook = s; }, e => { window.__qaHook = {error: String(e)}; }); return true;")
    time.sleep(0.2)
    status = app.js("return window.__qaHook;") or {}
    status["panel"] = app.dataset("vncSpecialKeys")
    return status


def _special_keys(app: App, args, scenario: str, expect_remote: bool) -> None:
    for label, action, want in SPECIAL_KEY_PROBES:
        app.focus_canvas()
        time.sleep(0.4)
        if not app.ours_in_front():
            app.run.record(scenario, label, False, reason="QA window not in front; key not sent")
            continue
        before = hook_status(app)
        since = now()
        action()
        wait_events(args, since, lambda ev: len(keys(ev)) >= len(want), 2)
        time.sleep(0.8)
        got = keys(events_since(args, since, ("key",)))
        front = app.ours_in_front()
        local = "" if front else foreground_image()
        after = hook_status(app) if front else {}
        ok = (got == want and front) if expect_remote else True
        app.run.record(scenario, label, ok, got=[[d, hex(k)] for d, k in got], foreground_ours=front,
                       local_surface=local or None, remote_matches=got == want, hook_before=before,
                       intercepted=(after.get("intercepted", 0) - before.get("intercepted", 0)) if after else None)
        if not front:
            dismiss_shell_surface()
            time.sleep(0.3)
            app.activate()
        time.sleep(0.4)


def scenario_special_keys(app: App, args) -> None:
    """VNC-INPUT-003-A1: Win, Alt+Tab, Alt+Esc, Ctrl+Esc and PrtScn go to the remote (Windows hook on)."""
    if not app.os_input:
        app.run.record("special-keys", "unrun", False, reason="no interactive desktop: the WH_KEYBOARD_LL hook needs real OS input")
        return
    _special_keys(app, args, "special-keys", expect_remote=True)


def set_pass_special_keys(app: App, enabled: bool) -> None:
    open_menu(app)
    menu_pick(app, None, "vnc-menu-properties")
    app.wait_js("!!document.querySelector('[data-testid=\"vnc-properties\"]')", timeout=5)
    app.set_value("vnc-prop-special-keys", enabled)
    app.click_testid("vnc-prop-ok")
    app.wait_js("!document.querySelector('[data-testid=\"vnc-properties\"]')", timeout=5)
    time.sleep(0.5)


def scenario_special_keys_off(app: App, args) -> None:
    """VNC-INPUT-003-A1: with "Pass special keys" off the same keys stay local; records where each went."""
    if not app.os_input:
        app.run.record("special-keys-off", "unrun", False, reason="no interactive desktop")
        return
    set_pass_special_keys(app, False)
    try:
        _special_keys(app, args, "special-keys-off", expect_remote=False)
    finally:
        app.activate()
        set_pass_special_keys(app, True)


def scenario_pointer_latency(app: App, args) -> None:
    """VNC-PERF-005-A1 / VNC-INPUT-001-A4: same method as the RealVNC runs
    (vnc_pointer_latency.py, 40 moves every 200 ms, plain 6-byte PointerEvents)."""
    import sys
    from pathlib import Path

    script = Path(__file__).with_name("vnc_pointer_latency.py")
    if not app.os_input:
        app.run.record("pointer-latency", "unrun", False, reason="no interactive desktop: SetCursorPos latency needs real OS input")
        return
    for run in range(args.latency_runs):
        app.focus_canvas()
        x, y, w, h = app.canvas_rect_screen()
        result = subprocess.run(
            [sys.executable, str(script), "--up-log", args.up_log, "--x", str(x + w // 3), "--y", str(y + h // 3),
             "--moves", "40", "--interval-ms", "200", "--size", str(args.pointer_size), "--label", f"taomni-{run}",
             "--dump", str(app.run.report / "pointer-latency.jsonl")],
            capture_output=True, text=True, timeout=120,
        )
        line = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else result.stderr[-300:]
        fields = dict(part.split("=", 1) for part in line.split()[1:] if "=" in part)
        app.run.record("pointer-latency", f"run-{run}", "median_ms" in fields, line=line, foreground_ours=app.ours_in_front())
        time.sleep(1.0)


def scenario_viewport_origin(app: App, args) -> None:
    """Where the WebView viewport sits in the top-level window's client area
    (physical px), and which window WindowFromPoint returns over the canvas."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    app.focus_canvas()
    page = app.js("const r = document.querySelector('[data-testid=\"vnc-canvas\"]').getBoundingClientRect();"
                  "return {dpr: devicePixelRatio, inner: [innerWidth, innerHeight], screen: [screenX, screenY],"
                  " canvas: [r.left, r.top, r.width, r.height]};")
    x, y, w, h = app.canvas_rect_screen()
    point = wintypes.POINT(x + w // 2, y + h // 2)
    hit = user32.WindowFromPoint(point)
    root = user32.GetAncestor(hit, 2)
    names = []
    for hwnd in (hit, root):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buf, 256)
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        origin = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(origin))
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        names.append({"class": buf.value, "client": [rect.right, rect.bottom], "origin": [origin.x, origin.y],
                      "pid": pid.value})
    app.run.record("viewport-origin", "geometry", True, page=page, canvas_screen=[x, y, w, h],
                   hit=names[0], root=names[1], app_pid=app.pid)


IPC_HOOK = r"""
const internals = window.__TAURI_INTERNALS__;
if (internals && !window.__ipcTrace) {
  const trace = window.__ipcTrace = {invokes: [], callbacks: 0};
  const invoke = internals.invoke.bind(internals);
  internals.invoke = (cmd, payload, options) => {
    trace.invokes.push([performance.now(), String(cmd)]);
    return invoke(cmd, payload, options);
  };
  const runCallback = internals.runCallback?.bind(internals);
  if (runCallback) internals.runCallback = (...args) => { trace.callbacks += 1; return runCallback(...args); };
}
if (window.__ipcTrace) { window.__ipcTrace.invokes.length = 0; window.__ipcTrace.callbacks = 0; }
return !!window.__ipcTrace;
"""


def scenario_ipc_idle(app: App, args) -> None:
    """Which Tauri commands the page invokes while a VNC session idles: each
    one is WebView2 browser-process work that competes with pointer input."""
    import collections
    import json

    hooked = app.js(IPC_HOOK)
    time.sleep(args.hold_seconds)
    trace = json.loads(app.js("return JSON.stringify(window.__ipcTrace || null);") or "null")
    counts = collections.Counter(cmd for _, cmd in trace["invokes"]) if trace else {}
    app.run.record("ipc-idle", "invokes", bool(hooked), seconds=args.hold_seconds,
                   commands=dict(counts.most_common()), callbacks=trace["callbacks"] if trace else None)


def scenario_cpu_idle(app: App, args) -> None:
    """CPU of the QA app and its WebView2 processes while the session idles:
    a busy browser process delays pointer input by whole vsync periods."""
    import psutil

    root = psutil.Process(app.pid)
    processes = [root, *root.children(recursive=True)]
    for process in processes:
        try:
            process.cpu_percent(None)
        except psutil.Error:
            pass
    time.sleep(args.hold_seconds)
    usage = []
    for process in processes:
        try:
            cmdline = " ".join(process.cmdline())
            kind = next((part.split("=", 1)[1] for part in process.cmdline() if part.startswith("--type=")), "browser"
                        if "msedgewebview2" in process.name().lower() else "app")
            usage.append({"pid": process.pid, "name": process.name(), "type": kind,
                          "cpu_percent": round(process.cpu_percent(None), 1),
                          "utility": "network" if "network.mojom" in cmdline else None})
        except psutil.Error:
            continue
    app.run.record("cpu-idle", "processes", True, seconds=args.hold_seconds,
                   usage=sorted(usage, key=lambda item: -item["cpu_percent"]))


def scenario_pointer_trace(app: App, args) -> None:
    """VNC-PERF-005 tail breakdown: the pointer-latency method plus page-clock
    stamps (event timeStamp, listener, WebSocket send), split into segments."""
    import json
    import sys
    from pathlib import Path

    from vnc_pointer_trace import TRACE_HOOK, segments, summary

    script = Path(__file__).with_name("vnc_pointer_latency.py")
    if not app.os_input:
        app.run.record("pointer-trace", "unrun", False, reason="no interactive desktop: SetCursorPos latency needs real OS input")
        return
    raw_path = app.run.report / "pointer-trace-raw.jsonl"
    rows = []
    for run in range(args.latency_runs):
        app.focus_canvas()
        app.js(TRACE_HOOK)
        x, y, w, h = app.canvas_rect_screen()
        before = raw_path.read_text(encoding="utf-8").count("\n") if raw_path.exists() else 0
        subprocess.run(
            [sys.executable, str(script), "--up-log", args.up_log, "--x", str(x + w // 3), "--y", str(y + h // 3),
             "--moves", "40", "--interval-ms", "200", "--size", str(args.pointer_size), "--label", f"trace-{run}",
             "--raw-dump", str(raw_path)],
            capture_output=True, text=True, timeout=120,
        )
        lines = raw_path.read_text(encoding="utf-8").splitlines() if raw_path.exists() else []
        if len(lines) <= before:
            app.run.record("pointer-trace", f"run-{run}", False, reason="no raw dump")
            continue
        pairs = json.loads(lines[-1])["pairs"]
        trace = json.loads(app.js("return JSON.stringify(window.__vncTrace);"))
        try:
            run_rows = segments(pairs, trace)
        except ValueError as error:
            app.run.record("pointer-trace", f"run-{run}", False, reason=str(error))
            continue
        rows.extend(run_rows)
        app.run.record("pointer-trace", f"run-{run}", bool(run_rows), samples=len(run_rows),
                       foreground_ours=app.ours_in_front())
        time.sleep(1.0)
    (app.run.report / "pointer-trace-rows.json").write_text(json.dumps(rows), encoding="utf-8")
    app.run.record("pointer-trace", "summary", bool(rows), **summary(rows))


def scenario_paint(app: App, args) -> None:
    """VNC-PERF-003-A1/A3: full-frame main-thread cost and idle rAF load."""
    samples = []
    for _ in range(5):
        open_menu(app)
        menu_pick(app, None, "vnc-menu-refresh")
        time.sleep(2.5)
        samples.append(app.dataset("vncFullFrameMs"))
    control(args, "freeze")
    time.sleep(1.0)
    app.js(
        "window.__qaRaf = 0; const orig = window.requestAnimationFrame.bind(window);"
        "window.requestAnimationFrame = (cb) => { window.__qaRaf += 1; return orig(cb); }; return true;"
    )
    time.sleep(3.0)
    idle = app.js("return window.__qaRaf;")
    control(args, "thaw")
    app.run.record("paint", "full-frame-receive-plus-paint-ms", bool(samples[-1]), samples=samples)
    app.run.record("paint", "idle-raf-callbacks-3s", idle == 0, count=idle)


def scenario_properties(app: App, args) -> None:
    """VNC-CONN-001-A2: Properties persist and apply after reconnecting."""
    open_menu(app)
    menu_pick(app, None, "vnc-menu-properties")
    app.wait_js("!!document.querySelector('[data-testid=\"vnc-properties\"]')", timeout=5)
    app.set_value("vnc-prop-quality", "medium")
    app.set_value("vnc-prop-menu-key", "F9")
    app.set_value("vnc-prop-view-only", True)
    reconnect_hint = app.exists("vnc-prop-reconnect-hint")
    since = now()
    app.click_testid("vnc-prop-ok-reconnect")
    wait_connected(app, 25)
    time.sleep(1.5)
    encodings = next((e["encodings"] for e in events_since(args, since, ("set_encodings",))), [])
    app.focus_canvas()
    key_since = now()
    app.key("F9")
    menu = wait_overlay(app, "vnc-menu-send-cad", 3)
    disabled = app.js("return document.querySelector('[data-testid=\"vnc-menu-send-cad\"]')?.getAttribute('aria-disabled') ?? document.querySelector('[data-testid=\"vnc-menu-send-cad\"]')?.disabled;")
    app.key("Escape")
    app.focus_canvas()
    app.key("a")  # must not reach the remote in view-only
    time.sleep(0.6)
    remote_keys = keys(events_since(args, key_since, ("key",)))
    app.run.record("properties", "apply-after-reconnect", reconnect_hint and menu and not remote_keys and bool(encodings)
                   and encodings[0] == 7, encodings=encodings[:7], menu_item_disabled=disabled, remote_keys=len(remote_keys))


def scenario_layouts(app: App, args) -> None:
    """VNC-INPUT-003-A2: German AltGr and dead keys, Chinese IME on (Windows, OS input)."""
    if not app.os_input:
        app.run.record("layouts", "unrun", False, reason="no interactive desktop: layouts need real OS input")
        return
    from vnc_layouts import PROBES, layout_for
    from vnc_native import window_of_pid

    from vnc_layouts import warm_up

    for label, klid, action, want in PROBES:
        app.focus_canvas()
        time.sleep(0.3)
        with layout_for(window_of_pid(app.pid), klid) as layout:
            warm_up()
            since = now()
            action()
            events = wait_events(args, since, lambda ev: len(keys(ev)) >= len(want), 3)
            time.sleep(0.4)
        got = keys(events_since(args, since, ("key",)))
        app.run.record("layouts", label, got == want, got=[[d, hex(k)] for d, k in got], layout=layout,
                       foreground_ours=app.ours_in_front())
