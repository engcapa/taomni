#!/usr/bin/env python3
"""Drive the native QA build (never the user's install) through VNC scenarios.

    python vnc_native.py --report qa-ui-auto-report/vnc-native/<run> --host 127.0.0.1 --port 5988 \
        --password-env TAOMNI_VNC_FIXTURE_PASSWORD [--policy prefer-off] --scenario connect ...

The QA binary (native_build.py --release) runs with isolated app data under
--report through tauri-driver + msedgedriver. The helpers here create a VNC
session through the Session Editor, open it, answer the unencrypted warning
and wait for pixels, then expose small building blocks (OS-level input via
SendInput, page probes) that scenario modules compose. Results are JSON lines
in <report>/results.jsonl; screenshots stay under the gitignored report dir.
Credentials only come from environment variables and are never written out.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / ".agents/skills/qa-ui-auto/scripts"))

from tauri_webdriver import NativeHarness, NativeSession  # noqa: E402

RELEASE_BINARY = ROOT / "src-tauri/target/qa-ui-auto/release/taomni.exe"
QA_VAULT_PASSWORD = "qa-native-vnc-vault"

user32 = ctypes.windll.user32 if os.name == "nt" else None
if user32:
    user32.SetProcessDPIAware()

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE = 0x1, 0x2, 0x8
MOUSEEVENTF = {"left": (0x2, 0x4), "right": (0x8, 0x10), "middle": (0x20, 0x40)}
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x800, 0x1000


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("padding", ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def send_inputs(*inputs: INPUT) -> None:
    array = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))


def key_input(vk: int = 0, scan: int = 0, up: bool = False, extended: bool = False) -> INPUT:
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if extended else 0)
    if scan and not vk:
        flags |= KEYEVENTF_SCANCODE
    return INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=KEYBDINPUT(vk, scan, flags, 0, 0)))


def tap(vk: int, extended: bool = False) -> None:
    send_inputs(key_input(vk, extended=extended), key_input(vk, up=True, extended=extended))


def chord(*vks: int) -> None:
    """Press the keys in order and release them in reverse."""
    send_inputs(*[key_input(vk) for vk in vks], *[key_input(vk, up=True) for vk in reversed(vks)])


def mouse_click(x: int, y: int, button: str = "left") -> None:
    user32.SetCursorPos(x, y)
    time.sleep(0.05)
    down, up = MOUSEEVENTF[button]
    send_inputs(INPUT(INPUT_MOUSE, _INPUTUNION(mi=MOUSEINPUT(0, 0, 0, down, 0, 0))),
                INPUT(INPUT_MOUSE, _INPUTUNION(mi=MOUSEINPUT(0, 0, 0, up, 0, 0))))


def mouse_wheel(x: int, y: int, delta: int, horizontal: bool = False) -> None:
    user32.SetCursorPos(x, y)
    time.sleep(0.05)
    flag = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    send_inputs(INPUT(INPUT_MOUSE, _INPUTUNION(mi=MOUSEINPUT(0, 0, ctypes.c_uint32(delta).value, flag, 0, 0))))


def bring_to_front(hwnd: int) -> bool:
    """Foreground a window despite the foreground lock (thread-input attach,
    then a click on its own title bar as a last resort)."""
    kernel32 = ctypes.windll.kernel32
    for attempt in range(3):
        fg = user32.GetForegroundWindow()
        fg_thread = user32.GetWindowThreadProcessId(fg, None)
        me = kernel32.GetCurrentThreadId()
        attached = fg_thread and fg_thread != me and user32.AttachThreadInput(me, fg_thread, True)
        user32.ShowWindow(hwnd, 9 if user32.IsIconic(hwnd) else 5)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
        time.sleep(0.3)
        if user32.GetForegroundWindow() == hwnd:
            return True
        if attempt == 1:
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            mouse_click(rect.left + (rect.right - rect.left) // 2, rect.top + 12)
            time.sleep(0.3)
    return user32.GetForegroundWindow() == hwnd


def interactive_desktop() -> bool:
    """False when the Windows session is locked or disconnected: SendInput and
    low-level keyboard hooks then see nothing, so OS-input checks cannot run."""
    handle = user32.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_SWITCHDESKTOP
    if not handle:
        return False
    user32.CloseDesktop(handle)
    return bool(user32.GetForegroundWindow())


def foreground_pid() -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(pid))
    return pid.value


def find_process(executable: Path) -> int:
    """PID of the running process whose image is `executable` (0 if none)."""
    psapi = ctypes.windll.psapi
    kernel32 = ctypes.windll.kernel32
    pids = (wintypes.DWORD * 4096)()
    needed = wintypes.DWORD()
    psapi.EnumProcesses(ctypes.byref(pids), ctypes.sizeof(pids), ctypes.byref(needed))
    target = str(executable.resolve()).lower()
    for pid in pids[: needed.value // ctypes.sizeof(wintypes.DWORD)]:
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            continue
        try:
            size = wintypes.DWORD(1024)
            buf = ctypes.create_unicode_buffer(1024)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)) and buf.value.lower() == target:
                return pid
        finally:
            kernel32.CloseHandle(handle)
    return 0


def window_of_pid(pid: int) -> int:
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    best, area = 0, -1
    for hwnd in found:
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        size = (rect.right - rect.left) * (rect.bottom - rect.top)
        if size > area:
            best, area = hwnd, size
    return best


class Run:
    def __init__(self, report: Path) -> None:
        self.report = report
        self.report.mkdir(parents=True, exist_ok=True)
        self.results = open(report / "results.jsonl", "a", encoding="utf-8")

    def record(self, scenario: str, check: str, ok: bool, **details) -> None:
        line = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "scenario": scenario, "check": check,
                "ok": bool(ok), **details}
        self.results.write(json.dumps(line, ensure_ascii=False) + "\n")
        self.results.flush()
        print(("PASS " if ok else "FAIL ") + json.dumps(line, ensure_ascii=False), flush=True)


class App:
    """One QA app process with a VNC session open."""

    def __init__(self, harness: NativeHarness, session: NativeSession, run: Run) -> None:
        self.harness = harness
        self.session = session
        self.run = run
        self.pid = find_process(RELEASE_BINARY)

    # ── page probes ───────────────────────────────────────────────────
    def js(self, body: str):
        return self.session.execute(body)

    def wait_js(self, expression: str, timeout: float = 30.0, interval: float = 0.25):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.js(f"return ({expression});")
                if last:
                    return last
            except Exception as error:  # noqa: BLE001
                last = str(error)
            time.sleep(interval)
        raise TimeoutError(f"timed out waiting for {expression!r}; last={last!r}")

    def exists(self, testid: str) -> bool:
        return bool(self.js(f"return !!document.querySelector('[data-testid=\"{testid}\"]');"))

    def click_testid(self, testid: str) -> None:
        self.js(f"document.querySelector('[data-testid=\"{testid}\"]').click(); return true;")

    def set_value(self, testid: str, value) -> None:
        """Set a React-controlled input/select/checkbox through its native setter."""
        self.js(
            "const el = document.querySelector('[data-testid=\"%s\"]');"
            "const v = %s;"
            "if (el.type === 'checkbox') { if (el.checked !== v) el.click(); return true; }"
            "const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;"
            "Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);"
            "el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));"
            "return true;" % (testid, json.dumps(value))
        )

    def canvas_rect_screen(self) -> tuple[int, int, int, int]:
        """Canvas box in physical screen pixels."""
        box = self.js(
            "const r = document.querySelector('[data-testid=\"vnc-canvas\"]').getBoundingClientRect();"
            "return [r.left, r.top, r.width, r.height, window.devicePixelRatio];"
        )
        hwnd = window_of_pid(self.pid) or user32.GetForegroundWindow()
        point = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(point))
        left, top, width, height, dpr = box
        return (int(point.x + left * dpr), int(point.y + top * dpr), int(width * dpr), int(height * dpr))

    def canvas_center(self) -> tuple[int, int]:
        x, y, w, h = self.canvas_rect_screen()
        return x + w // 2, y + h // 2

    def focus_canvas(self) -> None:
        if self.os_input:
            self.activate()
            x, y = self.canvas_center()
            # Focus via a pointer-free route: DOM focus, then a real left click
            # would press a remote button, so only move the cursor inside.
            user32.SetCursorPos(x, y)
        self.js("document.querySelector('[data-testid=\"vnc-canvas\"]').focus(); return true;")
        time.sleep(0.2)

    def activate(self) -> None:
        hwnd = window_of_pid(self.pid)
        if not hwnd or self.ours_in_front():
            return
        bring_to_front(hwnd)

    # ── input: OS SendInput when an interactive desktop exists, otherwise
    #    trusted W3C Actions (CDP Input.dispatch*) into the native WebView ──
    @property
    def os_input(self) -> bool:
        return interactive_desktop()

    def _actions(self, source: dict) -> None:
        try:
            self.session.request("POST", self.session.endpoint("/actions"), {"actions": [source]})
        finally:
            try:
                self.session.request("DELETE", self.session.endpoint("/actions"))
            except Exception:  # noqa: BLE001
                pass

    def _canvas_origin(self) -> dict:
        element = self.session.find("[data-testid='vnc-canvas']")
        return {"element-6066-11e4-a52e-4f735466cecf": element}

    def key(self, combo: str) -> None:
        """Press a chord such as "F8", "Escape" or "Alt+Tab" on the focused canvas."""
        self.session.press_combo(combo)

    def click_canvas(self, button: int = 0, dx: int = 0, dy: int = 0) -> None:
        """W3C button: 0 left, 1 middle, 2 right; offsets from the canvas centre (CSS px)."""
        origin = self._canvas_origin()
        self._actions({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "duration": 0, "origin": origin, "x": dx, "y": dy},
            {"type": "pointerDown", "button": button},
            {"type": "pause", "duration": 40},
            {"type": "pointerUp", "button": button},
        ]})

    def wheel_canvas(self, delta_y: int = 0, delta_x: int = 0) -> None:
        origin = self._canvas_origin()
        self._actions({"type": "wheel", "id": "wheel", "actions": [
            {"type": "scroll", "origin": origin, "x": 0, "y": 0, "deltaX": delta_x, "deltaY": delta_y, "duration": 0},
        ]})

    def move_canvas(self, dx: int, dy: int) -> None:
        origin = self._canvas_origin()
        self._actions({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "duration": 0, "origin": origin, "x": dx, "y": dy},
        ]})

    def move_viewport(self, x: int, y: int) -> None:
        self._actions({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "duration": 0, "origin": "viewport", "x": x, "y": y},
        ]})

    def ours_in_front(self) -> bool:
        return foreground_pid() == self.pid

    def screenshot(self, name: str) -> Path:
        path = self.run.report / f"{name}.png"
        self.session.screenshot(path)
        return path

    def dataset(self, key: str):
        return self.js(f"return document.querySelector('[data-testid=\"vnc-panel\"]')?.dataset?.{key} ?? null;")

    def connected(self) -> bool:
        return bool(self.js(
            "const c = document.querySelector('[data-testid=\"vnc-canvas\"]');"
            "return !!c && getComputedStyle(c).display !== 'none' && c.width > 1;"
        ))


def launch(report: Path, port_base: int = 4460) -> tuple[NativeHarness, NativeSession]:
    cfg = {
        "app": {"native_binary": str(RELEASE_BINARY)},
        "webdriver": {"port": port_base, "native_port": port_base + 1, "startup_timeout": 30},
    }
    harness = NativeHarness(cfg, report)
    harness.__enter__()
    try:
        session = harness.create_session()
    except BaseException:
        harness.__exit__(None, None, None)
        raise
    return harness, session


def vault_first_run(session: NativeSession) -> None:
    end = time.time() + 30
    while time.time() < end:
        state = session.execute(
            "return document.querySelector('[data-testid=\"vault-setup-dialog\"]') ? 'setup'"
            " : document.querySelector('[data-testid=\"vault-unlock-pw\"]') ? 'unlock'"
            " : document.querySelector('[data-testid=\"startup-vault-check\"]') ? 'wait'"
            " : document.querySelector('[data-testid=\"welcome-panel\"]') ? 'ready'"
            " : document.querySelector('[data-testid=\"sidebar\"]') ? 'ready' : 'wait';"
        )
        if state == "setup":
            session.fill("[data-testid='vault-setup-pw1']", QA_VAULT_PASSWORD)
            session.fill("[data-testid='vault-setup-pw2']", QA_VAULT_PASSWORD)
            session.click("[data-testid='vault-setup-confirm']")
            session.wait_absent("[data-testid='vault-setup-dialog']", timeout=30)
            return
        if state == "unlock":
            session.fill("[data-testid='vault-unlock-pw']", QA_VAULT_PASSWORD)
            session.click("[data-testid='vault-unlock-confirm']")
            time.sleep(1.0)
            if session.execute("return !!document.querySelector('[data-testid=\"vault-unlock-error\"]');"):
                session.click("[data-testid='vault-unlock-cancel']")
            continue
        if state == "ready":
            return
        time.sleep(0.5)
    raise TimeoutError("vault first run gate not reached")


def open_vnc(app: App, *, name: str, host: str, port: int, password: str | None,
             policy: str = "prefer-encryption", editor: dict | None = None,
             confirm_unencrypted: bool = True, wait_connected: float = 60.0) -> float:
    """Create a VNC session in the Session Editor and open it. Returns the
    seconds from submitting the password to the first painted frame."""
    session = app.session
    vault_first_run(session)
    session.click('text="New session…"')
    session.find("[data-testid='session-editor']", timeout=10)
    session.click("[data-testid='session-proto-vnc']")
    session.fill("[data-testid='session-host']", host)
    session.fill("[data-testid='session-port']", str(port))
    session.click("[data-testid='session-section-vnc']")
    app.set_value("session-vnc-security-policy", policy)
    for testid, value in (editor or {}).items():
        app.set_value(testid, value)
    session.click("[data-testid='session-section-bookmark']")
    session.fill("[data-testid='session-name']", name)
    session.click("[data-testid='session-save']")
    session.find(f"[data-testid='session-tree-item'][data-session-name='{name}']", timeout=10)
    session.dblclick(f"[data-testid='session-tree-item'][data-session-name='{name}']")
    if password is not None:
        session.find("[data-testid='auth-prompt']", timeout=15)
        session.fill("[data-testid='auth-password']", password)
        if app.js("return !!document.querySelector('[data-testid=\"auth-save-to-vault\"]')?.checked;"):
            app.click_testid("auth-save-to-vault")
        session.click("[data-testid='auth-submit']")
    started = time.time()
    end = started + wait_connected
    while time.time() < end:
        if confirm_unencrypted and app.exists("vnc-unencrypted-continue"):
            app.click_testid("vnc-unencrypted-continue")
        if app.connected():
            painted = app.js("return Number(document.querySelector('[data-testid=\"vnc-panel\"]').dataset.vncFramesPainted || 0);")
            if painted or time.time() - started > 3:
                return time.time() - started
        time.sleep(0.2)
    raise TimeoutError("VNC session did not connect")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5988)
    parser.add_argument("--password-env")
    parser.add_argument("--policy", default="prefer-encryption")
    parser.add_argument("--scenario", action="append", required=True)
    parser.add_argument("--hold", type=float, default=0.0, help="keep the app open N seconds at the end")
    parser.add_argument("--fixture-log", help="JSONL log of vnc_fixture_server.py (fixture scenarios)")
    parser.add_argument("--fixture-control", type=int, help="control port of vnc_fixture_server.py")
    parser.add_argument("--up-log", help="vnc_burst_proxy.py --up-log file (pointer-latency scenario)")
    parser.add_argument("--pointer-size", type=int, default=6, help="upstream PointerEvent chunk size")
    parser.add_argument("--latency-runs", type=int, default=3)
    parser.add_argument("--hold-seconds", type=float, default=20.0)
    parser.add_argument("--connect-timeout", type=float, default=90.0)
    parser.add_argument("--editor", action="append", default=[], metavar="TESTID=VALUE",
                        help="extra Session Editor field, e.g. session-vnc-quality=low")
    args = parser.parse_args()
    import vnc_native_scenarios as scenarios

    run = Run(Path(args.report))
    password = os.environ.get(args.password_env) if args.password_env else None
    harness, session = launch(run.report)
    try:
        app = App(harness, session, run)
        # The release QA build keeps its data between runs: a fresh name per run
        # guarantees the session under test is the one created with these options.
        seconds = open_vnc(app, name=f"qa-vnc-{time.strftime('%H%M%S')}", host=args.host, port=args.port, password=password,
                           policy=args.policy, wait_connected=args.connect_timeout,
                           editor=dict(item.split("=", 1) for item in args.editor))
        run.record("connect", "first-frame", True, seconds=round(seconds, 2),
                   input="os-sendinput" if app.os_input else "webdriver-actions (no interactive desktop)")
        for name in args.scenario:
            fn = getattr(scenarios, f"scenario_{name.replace('-', '_')}")
            try:
                fn(app, args)
            except Exception as error:  # noqa: BLE001
                run.record(name, "exception", False, error=str(error)[:500])
                app.screenshot(f"{name}-error")
        if args.hold:
            time.sleep(args.hold)
    finally:
        try:
            session.close()
        finally:
            harness.__exit__(None, None, None)


if __name__ == "__main__":
    main()
