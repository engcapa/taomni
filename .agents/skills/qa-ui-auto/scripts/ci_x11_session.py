"""Real X server and window-tree observations for SSH desktop acceptance."""
import os
from pathlib import Path
import platform
import secrets
import shlex
import subprocess
import threading


def publish_window_tree(report: Path, text: str, stop: threading.Event) -> None:
    pending = report.with_suffix(".tmp")
    pending.write_text(text, encoding="utf-8")
    while True:
        try:
            pending.replace(report)
            return
        except PermissionError:
            # A Windows assertion can hold the destination open without delete
            # sharing. Wait for that reader; shutdown must still interrupt us.
            if stop.wait(.05):
                pending.unlink(missing_ok=True)
                return


def observe_window_tree(argv: list[str], report: Path, stop: threading.Event) -> None:
    """Keep polling after a transient X client failure; never retain stale evidence."""
    while not stop.wait(.25):
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            text = result.stdout if result.returncode == 0 else (
                f"X11 window observation unavailable (exit {result.returncode}): {result.stderr}\n"
            )
        except (subprocess.TimeoutExpired, OSError) as error:
            text = f"X11 window observation unavailable: {error}\n"
        # Both successful samples and failures replace the previous observation.
        # Atomic publication keeps assertions from reading a truncated snapshot.
        publish_window_tree(report, text, stop)


def install():
    from ci_services import command
    system = platform.system()
    if system == "Linux":
        command(["sudo", "-n", "apt-get", "install", "-y", "x11-apps", "x11-utils", "xauth"])
    elif system == "Darwin":
        command(["brew", "install", "--cask", "xquartz"], timeout=600)
    else:
        root = Path(os.environ["QA_CYGWIN_ROOT"])
        command([root.parent / "qa-cygwin-setup.exe", "--quiet-mode", "--no-shortcuts",
                 "--no-startmenu", "--no-desktop", "--root", root,
                 "--local-package-dir", root.parent / "qa-cygwin-packages",
                 "--site", "https://mirrors.kernel.org/sourceware/cygwin/", "--packages",
                 "xorg-server-extra,xauth,xclock,xwininfo,xdpyinfo,font-misc-misc"], timeout=600)


def start(services):
    from ci_services import command, retry
    system = platform.system()
    binary = Path("/usr/bin") if system == "Linux" else Path("/opt/X11/bin") if system == "Darwin" else Path(os.environ["QA_CYGWIN_ROOT"]) / "bin"
    suffix = ".exe" if system == "Windows" else ""
    def tool(name): return binary / (name + suffix)
    def path(value):
        return command([tool("cygpath"), "-u", value]) if system == "Windows" else str(value)
    if system != "Linux":
        # Cocoa/WebView2 use their own desktop. A private Xvfb is the X11
        # destination; it must not steal the native application's OS display.
        display = ":81"
        authority = services.private / "x11-authority"
        authority.touch(mode=0o600)
        cookie = secrets.token_hex(16)
        command([tool("xauth"), "-f", path(authority), "add", display, ".", cookie])
        os.environ["DISPLAY"] = "127.0.0.1:81"
        os.environ["XAUTHORITY"] = str(authority)
        services.start_process([tool("Xvfb"), display, "-screen", "0", "1024x768x24",
                                "-listen", "tcp", "-auth", path(authority), "-noreset"], "x11-server")
    # Linux uses the invocation's owned Xvfb and cookie; keep its DISPLAY so
    # WebKitGTK, WebDriver, capture and the window manager share one desktop.
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("X11 acceptance requires the invocation's real display")
    retry(lambda: command([tool("xdpyinfo")]))
    report = services.root / "x11-window-tree.txt"
    stop = threading.Event()
    watcher = threading.Thread(target=observe_window_tree,
        args=([str(tool("xwininfo")), "-root", "-tree"], report, stop), daemon=True)
    watcher.start()
    services.cleanup_action("x11-window-observer", lambda: (stop.set(), watcher.join(6)))
    services.config["ssh_features"]["desktop_command"] = f"exec {shlex.quote(path(tool('xclock')))} -title TaomniQADesktop"
    services.config["ssh_features"]["desktop_windows"] = str(report)
    return {"real_x_server": True, "display": os.environ["DISPLAY"], "window_tree": str(report)}
