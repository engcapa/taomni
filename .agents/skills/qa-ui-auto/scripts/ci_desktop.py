"""Job-owned native desktop preflight. Run Linux inside dbus-run-session/Xvfb."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


class Desktop:
    def __init__(self, root: Path, capabilities: list[str]):
        self.root = root
        self.capabilities = capabilities
        self.processes = []
        self.logs = []

    def start(self, command, *, env=None):
        log = (self.root / (Path(command[0]).name + ".log")).open("w", encoding="utf-8")
        self.logs.append(log)
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=env)
        self.processes.append(process)
        return process

    def __enter__(self):
        self.root.mkdir(parents=True, exist_ok=True)
        system = platform.system()
        facts = {"platform": system, "architecture": platform.machine(), "input_transport": "webdriver"}
        try:
            if system == "Linux":
                for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS"):
                    if not os.environ.get(key):
                        raise RuntimeError(f"native desktop requires {key}; launch the complete session wrapper")
                os.environ["GDK_BACKEND"] = "x11"
                display = subprocess.check_output(["xdpyinfo"], text=True)
                if "XTEST" not in display:
                    raise RuntimeError("Xvfb lacks XTEST")
                self.start(["openbox", "--sm-disable"])
                for _ in range(40):
                    wm = subprocess.check_output(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], text=True)
                    if "window id" in wm:
                        break
                    time.sleep(0.25)
                else:
                    raise RuntimeError("window manager did not register EWMH")
                facts.update(display=os.environ["DISPLAY"], wm=wm.strip(), input_transport="X11/WebDriver")
                # Validate the actual Python used by clipboard-owner helpers.
                subprocess.run([sys.executable, "-c", "import tkinter as t; w=t.Tk(); w.update(); w.destroy()"], check=True)
                if "ime" in self.capabilities:
                    os.environ.update(GTK_IM_MODULE="fcitx", QT_IM_MODULE="fcitx", XMODIFIERS="@im=fcitx")
                    config = self.root / "ime-config"
                    directory = config / "fcitx5"
                    directory.mkdir(parents=True, exist_ok=True)
                    (directory / "profile").write_text(
                        "[Groups/0]\nName=Default\nDefault Layout=us\nDefaultIM=wbpy\n"
                        "[Groups/0/Items/0]\nName=keyboard-us\nLayout=\n"
                        "[Groups/0/Items/1]\nName=wbpy\nLayout=\n[GroupOrder]\n0=Default\n", encoding="utf-8")
                    if not Path("/usr/share/fcitx5/inputmethod/wbpy.conf").is_file():
                        raise RuntimeError("fcitx5 wbpy engine is not installed")
                    env = {**os.environ, "XDG_CONFIG_HOME": str(config.resolve())}
                    self.start(["fcitx5", "--replace"], env=env)
                    # The current engine is empty until a client owns focus.
                    # Keep a real GTK input context alive during this preflight.
                    gtk = self.start(["/usr/bin/python3", "-c",
                        "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk; "
                        "w=Gtk.Window(title='QA GTK IME probe'); e=Gtk.Entry(); w.add(e); "
                        "w.show_all(); w.present(); e.grab_focus(); Gtk.main()"], env=env)
                    for _ in range(60):
                        subprocess.run(["fcitx5-remote", "-s", "wbpy"], capture_output=True)
                        probe = subprocess.run(["fcitx5-remote", "-n"], capture_output=True, text=True)
                        if probe.returncode == 0 and probe.stdout.strip():
                            break
                        time.sleep(0.5)
                    else:
                        raise RuntimeError("fcitx5 session bus/engine did not become ready")
                    gtk.terminate()
                    gtk.wait(timeout=10)
                    self.processes.remove(gtk)
                    facts["ime"] = {"configured_engine": "wbpy", "observed_engine": probe.stdout.strip(),
                                    "note": "active composition/commit is verified by the selected native case"}
            elif system == "Windows":
                kernel = ctypes.windll.kernel32
                session = ctypes.c_ulong()
                if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)) or not session.value:
                    raise RuntimeError("interactive-desktop-unavailable: Session 0")
                user = ctypes.windll.user32
                user.OpenInputDesktop.restype = ctypes.c_void_p
                desktop = user.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_SWITCHDESKTOP
                if not desktop:
                    raise RuntimeError("interactive-desktop-unavailable: cannot open input desktop")
                user.CloseDesktop.argtypes = [ctypes.c_void_p]
                user.CloseDesktop(desktop)
                facts.update(session_id=session.value, screen=[user.GetSystemMetrics(0), user.GetSystemMetrics(1)])
                if min(facts["screen"]) <= 0:
                    raise RuntimeError("interactive desktop has no display")
            elif system == "Darwin":
                console = subprocess.check_output(["stat", "-f", "%Su", "/dev/console"], text=True).strip()
                if console in {"root", "loginwindow", ""}:
                    raise RuntimeError("aqua-session-unavailable: no console user")
                subprocess.run(["launchctl", "print", f"gui/{os.getuid()}"], check=True, stdout=subprocess.DEVNULL)
                source = self.root / "display-probe.swift"
                source.write_text('import AppKit\nlet app = NSApplication.shared\n'
                                  'guard !NSScreen.screens.isEmpty else { fatalError("No Aqua display") }\n'
                                  'let w = NSWindow(contentRect: NSRect(x:0,y:0,width:320,height:200), '
                                  'styleMask:[.titled], backing:.buffered, defer:false)\n'
                                  'w.title="Taomni QA display probe"\nw.makeKeyAndOrderFront(nil)\n'
                                  'RunLoop.current.run(until: Date(timeIntervalSinceNow:0.5))\n'
                                  'guard w.isVisible else { fatalError("Window invisible") }\n'
                                  'print(NSScreen.screens.count)\nw.close()\n', encoding="utf-8")
                screens = subprocess.check_output(["swift", str(source)], text=True, timeout=90).strip()
                facts.update(console_user=console, screens=screens, capture_kind="webview",
                             permissions="No Accessibility/Screen Recording request; system input unverified")
            facts["ready"] = True
            (self.root / "desktop-readiness.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for log in self.logs:
            log.close()
