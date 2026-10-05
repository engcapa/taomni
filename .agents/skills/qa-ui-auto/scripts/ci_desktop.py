"""Job-owned native desktop preflight for named Linux profiles and other OSes."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time

from qa_ui_auto.linux_profiles import DEFAULT_LINUX_PROFILE, LINUX_PROFILES


class Desktop:
    def __init__(self, root: Path, capabilities: list[str], linux_profile: str = DEFAULT_LINUX_PROFILE):
        self.root = root
        self.capabilities = capabilities
        self.processes = []
        self.logs = []
        self.linux_profile = linux_profile
        self.facts = {}
        self.environment_before = dict(os.environ)
        self.temporary = None

    def start(self, command, *, env=None):
        log = (self.root / (Path(command[0]).name + ".log")).open("w", encoding="utf-8")
        self.logs.append(log)
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=env,
                                   start_new_session=sys.platform != "win32")
        self.processes.append(process)
        return process

    def _wait(self, process, probe, description, attempts=60):
        for _ in range(attempts):
            if process.poll() is not None:
                raise RuntimeError(f"{description} exited during startup; see desktop logs")
            try:
                result = probe()
                if result:
                    return result
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass
            time.sleep(0.5)
        raise RuntimeError(f"{description} did not become ready; see desktop logs")

    def _vnc(self, facts):
        from ci_services import free_port, rfb_probe
        import secrets

        password = secrets.token_urlsafe(6)[:8]
        directory = Path(self.temporary.name)
        passwd = directory / "vnc.passwd"
        encoded = subprocess.check_output(["tigervncpasswd", "-f"], input=(password + "\n").encode())
        passwd.write_bytes(encoded)
        passwd.chmod(0o600)
        # Never replace an existing X server or remove another session's lock.
        number = next((n for n in range(100, 200)
                       if not Path(f"/tmp/.X{n}-lock").exists() and not Path(f"/tmp/.X11-unix/X{n}").exists()), None)
        if number is None:
            raise RuntimeError("no unused display for the VNC desktop")
        os.environ["DISPLAY"] = f":{number}"
        port = free_port()
        server = self.start(["Xtigervnc", os.environ["DISPLAY"], "-geometry", "1920x1080", "-depth", "24",
                             "-localhost", "-rfbport", str(port), "-SecurityTypes", "VncAuth",
                             "-PasswordFile", str(passwd), "-nolisten", "tcp", "-ac"])
        width, height, name = self._wait(server, lambda: rfb_probe(port, password), "VNC desktop")
        facts["vnc"] = {"server": "Xtigervnc", "host": "127.0.0.1", "port": port,
                        "authentication": "VncAuth", "size": [width, height], "name": name,
                        "purpose": "app host desktop; independent of vnc_required"}

    def _wayland(self, facts):
        runtime = Path(self.temporary.name) / "runtime"
        runtime.mkdir(mode=0o700)
        os.environ.pop("DISPLAY", None)
        os.environ.pop("XAUTHORITY", None)
        os.environ.update(XDG_RUNTIME_DIR=str(runtime), WAYLAND_DISPLAY="wayland-qa",
                          XDG_SESSION_TYPE="wayland", XDG_CURRENT_DESKTOP="ubuntu:GNOME",
                          GDK_BACKEND="wayland", LIBGL_ALWAYS_SOFTWARE="1",
                          WEBKIT_DISABLE_DMABUF_RENDERER="1")
        # Shell startup can activate portals itself. Publish the new session
        # environment first, otherwise DBus selects the GTK/X11 fallback and
        # those services keep the old runtime directory for the whole run.
        subprocess.run(["dbus-update-activation-environment", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY",
                        "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "GDK_BACKEND",
                        "LIBGL_ALWAYS_SOFTWARE", "WEBKIT_DISABLE_DMABUF_RENDERER"], check=True, timeout=20)
        pipewire = self.start(["pipewire"])
        self._wait(pipewire, lambda: (runtime / "pipewire-0").is_socket(), "PipeWire")
        self.start(["wireplumber"])
        shell = self.start(["gnome-shell", "--wayland", "--headless", "--virtual-monitor=1920x1080",
                            "--wayland-display=wayland-qa", "--mode=ubuntu"])
        self._wait(shell, lambda: (runtime / "wayland-qa").is_socket(), "GNOME Wayland compositor")
        protocols = subprocess.check_output(["wayland-info"], text=True, timeout=20)
        (self.root / "wayland-info.txt").write_text(protocols, encoding="utf-8")
        for interface in ("wl_compositor", "xdg_wm_base", "wl_output"):
            if interface not in protocols:
                raise RuntimeError(f"Wayland compositor does not advertise {interface}")
        # GTK's display object establishes the effective backend, rather than
        # inferring it merely from WAYLAND_DISPLAY (which can coexist with X11).
        probe = subprocess.check_output(["/usr/bin/python3", "-c",
            "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk,Gdk; "
            "w=Gtk.Window(title='QA Wayland backend probe'); w.show_all(); "
            "d=Gdk.Display.get_default(); print(d.__gtype__.name); "
            "print(d.get_n_monitors()); w.destroy()"], text=True, timeout=20).splitlines()
        if not probe or probe[0] != "GdkWaylandDisplay" or int(probe[1]) < 1:
            raise RuntimeError(f"GTK did not use a Wayland display: {probe}")
        portal = subprocess.check_output(["gdbus", "introspect", "--session", "--dest",
                   "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"],
                   text=True, timeout=60)
        (self.root / "portal-interfaces.txt").write_text(portal, encoding="utf-8")
        for interface in ("Screenshot", "ScreenCast", "RemoteDesktop"):
            if f"org.freedesktop.portal.{interface}" not in portal:
                raise RuntimeError(f"GNOME desktop portal lacks {interface}")
        facts.update(gdk_display=probe[0], monitors=int(probe[1]),
                     wayland_display=os.environ["WAYLAND_DISPLAY"], input_transport="Wayland/WebDriver",
                     renderer="software", screen=[1920, 1080],
                     gnome_version=subprocess.check_output(["gnome-shell", "--version"], text=True).strip(),
                     portal_interfaces=["Screenshot", "ScreenCast", "RemoteDesktop"],
                     note="GNOME virtual monitor; portal user consent and physical GPU/input are unverified")

    def _linux(self, facts):
        profile = LINUX_PROFILES[self.linux_profile]
        release = platform.freedesktop_os_release()
        if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != profile.version_id:
            raise RuntimeError(f"Linux profile {self.linux_profile} requires Ubuntu {profile.version_id}; "
                               f"observed {release.get('ID')} {release.get('VERSION_ID')}")
        facts.update(profile.identity(self.linux_profile), os_id=release["ID"], version_id=release["VERSION_ID"],
                     os_pretty_name=release.get("PRETTY_NAME"), runner_image=os.environ.get("ImageVersion"))
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            raise RuntimeError("native desktop requires DBUS_SESSION_BUS_ADDRESS; launch the complete session wrapper")
        self.temporary = tempfile.TemporaryDirectory(prefix="taomni-qa-desktop-")
        if profile.session_type == "wayland":
            self._wayland(facts)
            return
        os.environ.pop("WAYLAND_DISPLAY", None)
        os.environ.update(GDK_BACKEND="x11", XDG_SESSION_TYPE="x11")
        if profile.display_server == "Xtigervnc":
            self._vnc(facts)
        if not os.environ.get("DISPLAY"):
            raise RuntimeError("native desktop requires DISPLAY; launch the complete session wrapper")
        display = subprocess.check_output(["xdpyinfo"], text=True)
        if "XTEST" not in display:
            raise RuntimeError("X11 display lacks XTEST")
        if profile.desktop == "LXQt/Openbox":
            config = Path(self.temporary.name) / "config"
            (config / "lxqt").mkdir(parents=True)
            (config / "lxqt/session.conf").write_text("[General]\nwindow_manager=openbox\n", encoding="utf-8")
            (config / "autostart").mkdir()
            (config / "autostart/fcitx5.desktop").write_text("[Desktop Entry]\nHidden=true\n", encoding="utf-8")
            self.start(["lxqt-session"], env={**os.environ, "XDG_CONFIG_HOME": str(config),
                                            "XDG_CURRENT_DESKTOP": "LXQt"})
        else:
            self.start(["openbox", "--sm-disable"])
        for _ in range(40):
            wm = subprocess.check_output(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], text=True)
            if "window id" in wm:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("window manager did not register EWMH")
        facts.update(display=os.environ["DISPLAY"], wm=wm.strip(), input_transport="X11/WebDriver")
        if "display" in self.capabilities and profile.compositor == "xcompmgr":
            compositor = self.start(["xcompmgr", "-n"])
            time.sleep(0.25)
            if compositor.poll() is not None:
                raise RuntimeError("desktop compositor exited during startup")
        subprocess.run([sys.executable, "-c", "import tkinter as t; w=t.Tk(); w.update(); w.destroy()"], check=True)
        if "ime" in self.capabilities:
            self._ime(facts)

    def _ime(self, facts):
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

    def __enter__(self):
        self.root.mkdir(parents=True, exist_ok=True)
        system = platform.system()
        facts = {"platform": system, "architecture": platform.machine(), "input_transport": "webdriver"}
        try:
            if system == "Linux":
                self._linux(facts)
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
            self.facts = facts
            (self.root / "desktop-readiness.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
            return self
        except BaseException as exc:
            (self.root / "desktop-failure.json").write_text(
                json.dumps({**facts, "ready": False, "error": str(exc)}, indent=2), encoding="utf-8")
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        for process in reversed(self.processes):
            if process.poll() is None:
                if sys.platform != "win32" and isinstance(process.pid, int):
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                else:
                    process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if sys.platform != "win32" and isinstance(process.pid, int):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                process.wait()
        for log in self.logs:
            log.close()
        try:
            if self.temporary:
                # The DBus-activated document portal mounts FUSE inside this
                # private runtime. Detach only that owned mount before rmtree;
                # its daemon lives until the enclosing DBus session ends.
                documents = Path(self.temporary.name) / "runtime" / "doc"
                if sys.platform == "linux" and documents.is_mount():
                    subprocess.run(["fusermount3", "-uz", str(documents)], check=True, timeout=15)
                self.temporary.cleanup()
        finally:
            # The wrapper owns its original bus/display; only restore keys this
            # Desktop changed, without discarding unrelated service variables.
            for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
                        "XDG_CURRENT_DESKTOP", "GDK_BACKEND", "LIBGL_ALWAYS_SOFTWARE",
                        "WEBKIT_DISABLE_DMABUF_RENDERER", "GTK_IM_MODULE", "QT_IM_MODULE", "XMODIFIERS"):
                if key in self.environment_before:
                    os.environ[key] = self.environment_before[key]
                else:
                    os.environ.pop(key, None)
