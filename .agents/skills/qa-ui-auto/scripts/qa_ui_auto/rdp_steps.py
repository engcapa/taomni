"""Native verbs for RDP server/client cases (docs-feature/rdp-server-parity-design.md).

* ``open_route``      navigate the packaged main WebView to an app route
                      (e.g. ``?servers=main``) — the native analogue of
                      browser ``open: ${cfg.app.base_url}?servers=main``.
* ``host_helper``     start/stop the independent visual target on the host.
* ``rdp_probe``       run one ``rdp-probe`` scenario (foreground or
                      background) and assert values in its JSON report.
* ``rdp_probe_wait``  collect a background probe and assert its report.
* ``host_clipboard``  set/assert the real OS clipboard via platform tools.
* ``assert_json_file`` assert values in a JSON file inside the report root.
* ``rdp_canvas_click`` click a remote-desktop coordinate inside the Taomni
                      RDP client canvas with W3C pointer input.
* ``save_text``       keep an element's text (e.g. the server log) as a
                      report-root file for diagnostics, pass or fail.

Connection defaults come from the ``rdp_server_required`` fixture through
``QA_RDP_PORT`` / ``QA_RDP_USER`` / ``QA_RDP_PASSWORD``; the password is only
ever passed to the probe by environment-variable name.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .native_steps import NativeStepContext, _verb
from .steps import StepError
from . import host_clipboard
from .rdp_helpers.mstsc import launch as launch_mstsc
from .rdp_helpers.mstsc import diagnose as diagnose_mstsc
from .rdp_helpers.mstsc import file_launch_consent

HELPERS = Path(__file__).resolve().parent / "rdp_helpers"


def _probe_path(ctx: NativeStepContext) -> Path:
    configured = (ctx.cfg.get("app") or {}).get("native_binary")
    if configured:
        base = Path(str(configured)).expanduser().resolve().parent
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from native_build import qa_binary  # type: ignore[import-not-found]

        base = qa_binary().parent
    probe = base / ("rdp-probe.exe" if platform.system() == "Windows" else "rdp-probe")
    if not probe.is_file():
        raise StepError(f"rdp-probe binary not found next to the QA app: {probe}")
    return probe


def _within_report(ctx: NativeStepContext, raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = ctx.case_dir / path
    resolved = path.resolve()
    root = ctx.case_dir.parent.resolve()
    if not resolved.is_relative_to(root):
        raise StepError(f"path must stay inside the report root {root}: {resolved}")
    return resolved


def _register_cleanup(ctx: NativeStepContext, fn) -> None:
    cleanups = getattr(ctx, "_rdp_cleanups", None)
    if cleanups is None:
        cleanups = []
        ctx._rdp_cleanups = cleanups  # type: ignore[attr-defined]
        original = ctx.restore_host_permissions

        def restore() -> None:
            for cleanup in reversed(cleanups):
                try:
                    cleanup()
                except Exception:  # noqa: BLE001 - teardown is best effort
                    pass
            cleanups.clear()
            original()

        ctx.restore_host_permissions = restore  # type: ignore[method-assign]
    cleanups.append(fn)


def _stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if platform.system() == "Windows":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


# ------------------------------------------------------------------ open_route

@_verb("open_route")
def _do_open_route(ctx: NativeStepContext, args: Any) -> str:
    route = args.get("route") if isinstance(args, dict) else args
    if not isinstance(route, str) or not route.startswith(("?", "/", "#")):
        raise StepError("open_route: expected a route starting with ?, / or # (e.g. ?servers=main)")
    target = route if route.startswith("/") else "/" + route
    ctx.session.execute(
        "window.setTimeout(() => window.location.assign(window.location.origin + "
        + json.dumps(target) + "), 0); return true;"
    )
    time.sleep(2.0)  # document teardown; execute/sync is unavailable during it
    ctx.session.install_console_hook()
    return f"navigated main WebView to {target}"


# ----------------------------------------------------------------- host_helper

@_verb("host_helper")
def _do_host_helper(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or args.get("action") not in {"start", "stop"}:
        raise StepError("host_helper: expected {action: start|stop, name, mode?, geometry?}")
    name = str(args.get("name") or "target")
    helpers = getattr(ctx, "_rdp_helpers", None)
    if helpers is None:
        helpers = {}
        ctx._rdp_helpers = helpers  # type: ignore[attr-defined]
    if args["action"] == "stop":
        process = helpers.pop(name, None)
        if process is None:
            raise StepError(f"host_helper: no running helper named {name}")
        _stop_process(process)
        return f"stopped helper {name}"
    if name in helpers:
        raise StepError(f"host_helper: helper {name} is already running")
    state = _within_report(ctx, str(args.get("state") or f"{name}-state.json"))
    state.unlink(missing_ok=True)
    mode = str(args.get("mode") or "flip")
    if platform.system() == "Darwin" and mode == "flip":
        # Tk activates Python's GUI identity on macOS. A Python Local Network
        # consent sheet can then block the independent host input target even
        # though our services use loopback. Use a separate native window for
        # input checks, without changing consent or the animation baseline.
        command = ["swift", str(HELPERS / "rdp_target_macos.swift")]
    else:
        command = [sys.executable, str(HELPERS / "rdp_target.py"), "--mode", mode]
    command += ["--state", str(state),
                "--geometry", str(args.get("geometry") or "480x320+40+80")]
    if args.get("pattern"):
        command.append("--pattern")
    with (ctx.case_dir / f"{name}-helper.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    helpers[name] = process
    _register_cleanup(ctx, lambda: _stop_process(process))
    deadline = time.time() + float(args.get("timeout_sec") or 20)
    while time.time() < deadline:
        if process.poll() is not None:
            raise StepError(f"host_helper: {name} exited early ({process.returncode}); see {name}-helper.log")
        try:
            data = json.loads(state.read_text(encoding="utf-8"))
            if data.get("ready"):
                return f"helper {name} ready at {data.get('window')}"
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    raise StepError(f"host_helper: {name} did not report ready")


# ------------------------------------------------------------------- rdp_probe

def _probe_command(ctx: NativeStepContext, args: dict) -> tuple[list[str], Path]:
    scenario = args.get("scenario")
    if not isinstance(scenario, str) or not scenario:
        raise StepError("rdp_probe: expected {scenario, args?, artifact?, expect?}")
    artifact = _within_report(ctx, str(args.get("artifact") or f"rdp-probe-{scenario}") + ".json")
    command = [str(_probe_path(ctx)), scenario]
    connection = {
        "host": "127.0.0.1",
        "port": os.environ.get("QA_RDP_PORT", "3389"),
        "user": os.environ.get("QA_RDP_USER", ""),
        "password-env": "QA_RDP_PASSWORD",
    }
    extra = args.get("args") or {}
    if not isinstance(extra, dict):
        raise StepError("rdp_probe: args must be a mapping of probe options")
    for key, value in {**connection, **{str(k): v for k, v in extra.items()}}.items():
        if value is None or value == "":
            continue
        if value is True:
            command.append(f"--{key}")
        elif key in PATH_ARGS:
            # Relative paths name files in the case directory; ``files`` is a
            # comma-separated list.
            paths = [str(_within_report(ctx, part.strip())) for part in str(value).split(",") if part.strip()]
            command += [f"--{key}", ",".join(paths)]
        else:
            command += [f"--{key}", str(value)]
    command += ["--out", str(artifact)]
    if scenario not in OFFLINE_SCENARIOS and "snapshot" not in extra:
        # What the RDP client decoded, saved next to the report as evidence.
        command += ["--snapshot", str(artifact.with_suffix(".png"))]
    return command, artifact


OFFLINE_SCENARIOS = {"host-play", "host-record", "image-digest", "image-make"}
# Probe options that name host files; resolved inside the report root.
PATH_ARGS = {"png", "out-png", "image-png", "files", "out-dir", "wav-out", "snapshot", "baseline-report"}


@_verb("host_copy_file")
def _do_host_copy_file(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict):
        raise StepError("host_copy_file: expected {from_env_dir, name, to, expect?, timeout_sec?}")
    env_name, name = str(args.get("from_env_dir", "")), str(args.get("name", ""))
    if not env_name.startswith("QA_RDP_") or not os.environ.get(env_name):
        raise StepError("host_copy_file: source directory must be a set QA_RDP_ environment variable")
    if not name or name in {".", ".."} or any(char in name for char in "/\\:"):
        raise StepError("host_copy_file: name must be a single filename")
    root = Path(os.environ[env_name]).resolve()
    source = (root / name).resolve()
    if not source.is_relative_to(root):
        raise StepError("host_copy_file: source escapes its fixture directory")
    destination = _within_report(ctx, str(args.get("to") or name))
    deadline = time.monotonic() + float(args.get("timeout_sec") or 60)
    last_error = "file not ready"
    while time.monotonic() < deadline:
        try:
            shutil.copy2(source, destination)
            expect = args.get("expect") or {}
            problems = _check_expectations(json.loads(destination.read_text(encoding="utf-8")), expect, name) if expect else []
            if not problems:
                return f"copied {name} to {destination.name}"
            last_error = "; ".join(problems)
        except (OSError, ValueError) as exc:
            last_error = str(exc)
        time.sleep(0.25)
    raise StepError(f"host_copy_file: {last_error}")


@_verb("host_rdp_logoff")
def _do_host_rdp_logoff(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or args.get("user_env") not in {
        "QA_RDP_BASELINE_USER1", "QA_RDP_BASELINE_USER2"
    }:
        raise StepError("host_rdp_logoff: expected an owned reference user environment name")
    from .fixtures import rdp_baseline_required
    try:
        sessions = rdp_baseline_required.logoff_owned_session(os.environ.get(args["user_env"], ""))
    except (RuntimeError, subprocess.SubprocessError) as error:
        raise StepError(f"host_rdp_logoff: {error}") from error
    path = ctx.case_dir / "reference-logoff.json"
    path.write_text(json.dumps({"user_env": args["user_env"], "sessions": sessions,
                                "released": True}), encoding="utf-8")
    return f"released {len(sessions)} owned reference session(s)"


def _capture_mstsc(ctx: NativeStepContext, process: subprocess.Popen, args: dict) -> str:
    path = _within_report(ctx, str(args.get("snapshot") or "mstsc-window.png"))
    script = r'''
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QaMstscCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr FindVisibleWindow(uint pid) {
    IntPtr best = IntPtr.Zero; long largest = 0;
    EnumWindows((handle, parameter) => {
      uint owner; Rect rect;
      GetWindowThreadProcessId(handle, out owner);
      if (owner == pid && IsWindowVisible(handle) && GetWindowRect(handle, out rect)) {
        long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
        if (area > largest) { largest = area; best = handle; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
[void][QaMstscCapture]::SetProcessDPIAware()
$p = Get-Process -Id ([int]$env:QA_MSTSC_PID) -ErrorAction Stop
$window = [QaMstscCapture]::FindVisibleWindow([uint32]$p.Id)
$r = New-Object QaMstscCapture+Rect
if ($window -eq [IntPtr]::Zero -or -not [QaMstscCapture]::GetWindowRect($window,[ref]$r)) { throw 'mstsc visible window unavailable' }
$actor = 'PrintWindow'
if ($env:QA_MSTSC_PATTERN -eq 'true') {
  # PrintWindow can omit mstsc's accelerated client surface when occluded.
  # Put the owned client to the right of both known host targets, then read
  # its visible compositor pixels. The crop cannot contain the host targets.
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $left = $screen.Right - 324
  if ($left -lt 680) { throw 'desktop has no separate region for the owned mstsc viewport' }
  if (-not [QaMstscCapture]::SetWindowPos($window,[IntPtr](-1),$left,$screen.Top+10,314,235,0x40)) {
    throw 'could not position the owned mstsc viewport'
  }
  Start-Sleep -Milliseconds 1200
  if (-not [QaMstscCapture]::GetWindowRect($window,[ref]$r) -or $r.Left -lt 680) {
    throw 'mstsc viewport overlaps the independent host targets'
  }
  $actor = 'owned-visible-compositor-crop'
}
$captureX=$r.Left; $captureY=$r.Top
$w=$r.Right-$r.Left; $h=$r.Bottom-$r.Top
if ($actor -eq 'owned-visible-compositor-crop') {
  # mstsc may enforce a minimum window size larger than the requested one.
  # Keep the capture inside both the owned window and the visible desktop.
  $captureX=[Math]::Max($r.Left,$screen.Left)
  $captureY=[Math]::Max($r.Top,$screen.Top)
  $w=[Math]::Min($r.Right,$screen.Right)-$captureX
  $h=[Math]::Min($r.Bottom,$screen.Bottom)-$captureY
}
if ($w -lt 100 -or $h -lt 80) { throw 'mstsc window is too small' }
$bmp=New-Object System.Drawing.Bitmap $w,$h
$g=[System.Drawing.Graphics]::FromImage($bmp)
if ($actor -eq 'owned-visible-compositor-crop') {
  $g.CopyFromScreen($captureX,$captureY,0,0,$bmp.Size)
} else {
  $hdc=$g.GetHdc()
  try {
    if (-not [QaMstscCapture]::PrintWindow($window,$hdc,2)) { throw 'mstsc PrintWindow failed' }
  } finally { $g.ReleaseHdc($hdc) }
}
$bmp.Save($env:QA_MSTSC_CAPTURE,[System.Drawing.Imaging.ImageFormat]::Png)
[pscustomobject]@{capture_kind='owned-client-window'; actor=$actor; pid=$p.Id; hwnd=$window.ToInt64(); x=$captureX; y=$captureY; width=$w; height=$h;
  window_x=$r.Left; window_y=$r.Top; window_width=$r.Right-$r.Left; window_height=$r.Bottom-$r.Top} |
  ConvertTo-Json | Set-Content -Encoding UTF8 ($env:QA_MSTSC_CAPTURE + '.metadata.json')
$g.Dispose(); $bmp.Dispose()
'''
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            env={**os.environ, "QA_MSTSC_PID": str(process.pid), "QA_MSTSC_CAPTURE": str(path),
                                 "QA_MSTSC_PATTERN": "true" if args.get("expect_pattern") else "false"},
                            capture_output=True, text=True, timeout=45)
    if result.returncode or not path.is_file():
        (ctx.case_dir / "mstsc-capture-error.txt").write_text(
            f"exit={result.returncode}\n{result.stderr[-3000:]}\n{result.stdout[-3000:]}", encoding="utf-8")
        host_screenshot(ctx.case_dir / "mstsc-capture-failure.png")
        raise StepError(f"host_mstsc: window screenshot failed: {result.stderr[-500:]}")
    if args.get("expect_pattern"):
        from PIL import Image
        colors = Image.open(path).convert("RGB").getdata()
        magenta = cyan = 0
        for red, green, blue in colors:
            magenta += int(red > 170 and green < 90 and blue > 170)
            cyan += int(red < 90 and green > 170 and blue > 170)
        if min(magenta, cyan) < 200:
            raise StepError(f"host_mstsc: remote pattern missing in {path.name} (magenta={magenta}, cyan={cyan}); check for authentication/certificate dialogs")
    return f"mstsc window captured: {path.name}"


@_verb("host_mstsc")
def _do_host_mstsc(ctx: NativeStepContext, args: Any) -> str:
    if platform.system() != "Windows":
        raise StepError("host_mstsc requires Windows")
    if not isinstance(args, dict) or args.get("action") not in {"start", "capture", "stop"}:
        raise StepError("host_mstsc: expected {action: start|capture|stop, port?, user?, password_env?}")
    current = getattr(ctx, "_mstsc_process", None)
    if args["action"] == "capture":
        if current is None:
            raise StepError("host_mstsc: no owned mstsc process")
        return _capture_mstsc(ctx, current, args)
    if args["action"] == "stop":
        if current is None:
            raise StepError("host_mstsc: no owned mstsc process")
        ctx._mstsc_cleanup()
        ctx._mstsc_process = None
        return "stopped mstsc and removed disposable credentials"
    if current is not None:
        raise StepError("host_mstsc: an owned session is already running")
    password_env = str(args.get("password_env") or "QA_RDP_PASSWORD")
    password = os.environ.get(password_env)
    if not password:
        raise StepError("host_mstsc: password environment variable is unset")
    user = str(args.get("user") or os.environ.get("QA_RDP_USER", ""))
    port = int(args.get("port") or os.environ.get("QA_RDP_PORT", "3389"))
    if not 1 <= port <= 65535 or not user or any(c in user for c in "\r\n"):
        raise StepError("host_mstsc: invalid loopback port or username")
    target = "TERMSRV/127.0.0.1"
    added = subprocess.run(["cmdkey", f"/generic:{target}", f"/user:{user}", f"/pass:{password}"], capture_output=True, timeout=30)
    if added.returncode:
        raise StepError("host_mstsc: cmdkey could not store disposable credentials")
    process = None
    host_state = ExitStack()
    dump_state = ExitStack()

    def cleanup_process() -> None:
        nonlocal process
        if process is not None:
            try:
                diagnose_mstsc(process, ctx.case_dir)
                diagnostics = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                     "Get-Process mstsc -ErrorAction SilentlyContinue | "
                     "Select-Object Id,SessionId,MainWindowHandle,MainWindowTitle,Path,CPU,StartTime,Responding | ConvertTo-Json; "
                     "Get-CimInstance Win32_Process -Filter \"Name='mstsc.exe'\" | "
                     "Select-Object ProcessId,ParentProcessId,SessionId,CommandLine | ConvertTo-Json; "
                     "Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational'; "
                     "StartTime=(Get-Date).AddMinutes(-3)} -ErrorAction SilentlyContinue | "
                     "Select-Object TimeCreated,Id,Message | ConvertTo-Json"],
                    capture_output=True, text=True, timeout=30)
                (ctx.case_dir / "mstsc-process-state.txt").write_text(
                    f"owned_pid={process.pid} exit={process.poll()}\n{diagnostics.stdout}\n{diagnostics.stderr}",
                    encoding="utf-8")
            except Exception:
                pass  # Diagnostics must not prevent process and credential restoration.
            if process.poll() is None:
                try:
                    _capture_mstsc(ctx, process, {"snapshot": "mstsc-last-window.png"})
                except Exception:
                    pass  # Capture is diagnostic; owned process/credential cleanup must finish.
            try:
                _stop_process(process)
            finally:
                try:
                    dump_state.close()
                    from .rdp_helpers.mstsc import crash_diagnostics
                    try:
                        crash_diagnostics(process, ctx.case_dir)
                    except Exception as error:
                        (ctx.case_dir / "mstsc-crash-diagnostic-error.txt").write_text(str(error), encoding="utf-8")
                finally:
                    process.close()
                    process = None
    def cleanup() -> None:
        try:
            cleanup_process()
        finally:
            try:
                subprocess.run(["cmdkey", f"/delete:{target}"], capture_output=True, timeout=30)
            finally:
                host_state.close()

    _register_cleanup(ctx, cleanup)
    rdp = _within_report(ctx, "mstsc.rdp")
    options = [f"full address:s:127.0.0.1:{port}", f"username:s:{user}",
               "authentication level:i:0", "prompt for credentials:i:0", "promptcredentialonce:i:0",
               "enablecredsspsupport:i:1", "negotiate security layer:i:1", "screen mode id:i:1",
               "gatewayusagemethod:i:0", "disableconnectionsharing:i:1",
               "redirectprinters:i:0", "redirectsmartcards:i:0", "redirectwebauthn:i:0",
               "redirectcomports:i:0", "redirectposdevices:i:0", "drivestoredirect:s:", "devicestoredirect:s:",
               "winposstr:s:0,1,10,10,1014,750", "smart sizing:i:1", "compression:i:1",
               f"desktopwidth:i:{int(args.get('width') or 1024)}", f"desktopheight:i:{int(args.get('height') or 768)}",
               "session bpp:i:32", "audiomode:i:0", "redirectclipboard:i:1", "autoreconnection enabled:i:0"]
    try:
        host_state.enter_context(file_launch_consent())
        from .rdp_helpers.mstsc import crash_reporting, heap_verification
        host_state.enter_context(crash_reporting(ctx.case_dir))
        host_state.enter_context(heap_verification())
        # Avoid Windows text mode expanding CRLF to CRCRLF. mstsc also needs
        # the complete path when invoked outside the RDP file's directory.
        rdp.write_text("\r\n".join(options) + "\r\n", encoding="utf-16", newline="")
        process = launch_mstsc(rdp, port)
        from .rdp_helpers.mstsc import crash_capture
        dump_state.enter_context(crash_capture(process, ctx.case_dir))
    except BaseException:
        cleanup()
        raise
    ctx._mstsc_process = process
    ctx._mstsc_cleanup = cleanup
    return f"started owned mstsc process {process.pid}"


def host_screenshot(path: Path) -> str:
    """Best-effort full-desktop screenshot with platform tools (diagnostics only)."""
    system = platform.system()
    try:
        if system == "Darwin":
            result = subprocess.run(["screencapture", "-x", "-t", "png", str(path)],
                                    capture_output=True, text=True, timeout=30)
        elif system == "Windows":
            script = (
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
                "Add-Type -Namespace W -Name D -MemberDefinition "
                "'[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();';"
                "[void][W.D]::SetProcessDPIAware();"
                "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
                "$g=[System.Drawing.Graphics]::FromImage($bmp);"
                "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);"
                f"$bmp.Save('{path}',[System.Drawing.Imaging.ImageFormat]::Png)"
            )
            result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                                    capture_output=True, text=True, timeout=60)
        else:
            result = subprocess.run(["import", "-window", "root", str(path)],
                                    capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        return f"host screenshot unavailable: {exc}"
    if result.returncode or not path.is_file():
        return f"host screenshot failed ({result.returncode}): {(result.stderr or result.stdout)[-300:]}"
    return f"host screenshot {path.name}"


def _lookup(report: Any, dotted: str) -> Any:
    current = report
    for part in dotted.split("."):
        if isinstance(current, list) and part.isdigit():
            current = current[int(part)] if int(part) < len(current) else None
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _check_expectations(report: Any, expect: dict, label: str) -> list[str]:
    problems = []
    for dotted, rule in expect.items():
        value = _lookup(report, str(dotted))
        rules = rule if isinstance(rule, dict) else {"equals": rule}
        for op, wanted in rules.items():
            ok = True
            if op == "equals":
                ok = value == wanted
            elif op == "min":
                ok = isinstance(value, (int, float)) and value >= wanted
            elif op == "max":
                ok = isinstance(value, (int, float)) and value <= wanted
            elif op == "exists":
                ok = (value is not None) == bool(wanted)
            elif op == "contains":
                ok = value is not None and str(wanted) in (json.dumps(value) if not isinstance(value, str) else value)
            elif op == "excludes":
                # Absent counts as excluded: a format that was never listed.
                text = "" if value is None else (value if isinstance(value, str)
                                                 else json.dumps(value, ensure_ascii=False))
                ok = str(wanted) not in text
            elif op == "length_min":
                ok = isinstance(value, (list, dict, str)) and len(value) >= wanted
            else:
                problems.append(f"{label}: unknown expectation operator {op!r} for {dotted}")
                continue
            if not ok:
                problems.append(f"{label}: {dotted} {op} {wanted!r} failed (actual {value!r})")
    return problems


def _finish_probe(ctx: NativeStepContext, process: subprocess.Popen, artifact: Path,
                  args: dict, label: str, timeout: float) -> str:
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop_process(process)
        raise StepError(f"{label}: probe exceeded {timeout:.0f}s")
    try:
        report = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StepError(f"{label}: probe exited {process.returncode} without a readable report ({exc})")
    expected_exit = int(args.get("expect_exit", 0))
    problems = []
    if process.returncode != expected_exit:
        error = report.get("error") or {}
        problems.append(f"{label}: probe exit {process.returncode} != {expected_exit}: "
                        f"{error.get('kind')}: {error.get('message')}")
    problems += _check_expectations(report, args.get("expect") or {}, label)
    if problems:
        # Pair the client's decoded framebuffer with what the host shows.
        problems.append(host_screenshot(artifact.with_name(artifact.stem + "-host.png")))
        raise StepError("; ".join(problems))
    return f"{label}: {report.get('scenario')} ok in {report.get('elapsed_ms')} ms ({artifact.name})"


@_verb("rdp_probe")
def _do_rdp_probe(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict):
        raise StepError("rdp_probe: expected a mapping")
    command, artifact = _probe_command(ctx, args)
    artifact.unlink(missing_ok=True)
    log = (artifact.with_suffix(".log")).open("w", encoding="utf-8")
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=log)
    background = args.get("background")
    timeout = float(args.get("timeout_sec") or 180)
    if background:
        jobs = getattr(ctx, "_rdp_jobs", None)
        if jobs is None:
            jobs = {}
            ctx._rdp_jobs = jobs  # type: ignore[attr-defined]
        jobs[str(background)] = (process, artifact, timeout)
        _register_cleanup(ctx, lambda: _stop_process(process))
        return f"rdp_probe {args['scenario']} running in background as {background}"
    return _finish_probe(ctx, process, artifact, args, "rdp_probe", timeout)


@_verb("rdp_probe_wait")
def _do_rdp_probe_wait(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not args.get("name"):
        raise StepError("rdp_probe_wait: expected {name, expect?, expect_exit?}")
    jobs = getattr(ctx, "_rdp_jobs", {}) or {}
    job = jobs.pop(str(args["name"]), None)
    if job is None:
        raise StepError(f"rdp_probe_wait: no background probe named {args['name']}")
    process, artifact, timeout = job
    return _finish_probe(ctx, process, artifact, args, f"rdp_probe_wait[{args['name']}]",
                         float(args.get("timeout_sec") or timeout))


# -------------------------------------------------------------- host_clipboard

def _poll(check, timeout: float, what: str) -> Any:
    deadline = time.time() + timeout
    last: Any = None
    while True:
        try:
            ok, last = check()
            if ok:
                return last
        except Exception as exc:  # noqa: BLE001 - keep the last tool error
            last = f"{type(exc).__name__}: {exc}"
        if time.time() >= deadline:
            raise StepError(f"host_clipboard: {what} not satisfied within {timeout:.0f}s (last: {last!r})")
        time.sleep(0.3)


def _image_digest(ctx: NativeStepContext, png: Path) -> dict:
    result = subprocess.run([str(_probe_path(ctx)), "image-digest", "--png", str(png)],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise StepError(f"image-digest failed for {png}: {result.stdout[-500:]} {result.stderr[-500:]}")
    return json.loads(result.stdout)


@_verb("host_clipboard")
def _do_host_clipboard(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or args.get("action") not in {"set", "assert", "clear", "quiet", "capture"}:
        raise StepError("host_clipboard: expected {action: set|assert|clear|quiet|capture, kind, ...}")
    action, kind = args["action"], str(args.get("kind") or "text")
    timeout = float(args.get("timeout_sec") or 15)
    observations = ctx.case_dir / "host-clipboard-observations.json"
    record: dict[str, Any] = {"action": action, "kind": kind, "platform": platform.system()}
    failure = None
    if action == "capture":
        # Capture only an identified QA payload, never an arbitrary host clipboard.
        if kind != "text" or not args.get("name") or not args.get("contains"):
            raise StepError("host_clipboard capture requires text, name and a nonempty QA marker in contains")
        def capture_text():
            value = host_clipboard.get_text()
            return str(args["contains"]) in value, value
        value = _poll(capture_text, timeout, "identified QA text")
        if not hasattr(ctx, "_clipboard_samples"):
            ctx._clipboard_samples = {}
        ctx._clipboard_samples[args["name"]] = value
        record.update(name=args["name"], value=value)
    elif action == "clear":
        host_clipboard.clear()
    elif action == "quiet":
        # Nothing may keep rewriting the clipboard: an echo loop between two
        # peers sharing it shows up as a steady stream of changes.
        seconds = float(args.get("seconds") or 5)
        limit = int(args.get("max_changes") or 0)
        changes = host_clipboard.count_changes(seconds)
        record.update(seconds=seconds, changes=changes, max_changes=limit)
        if changes > limit:
            failure = f"host_clipboard: the clipboard changed {changes} times in {seconds:.0f}s (max {limit})"
    elif action == "set":
        if kind == "text":
            host_clipboard.set_text(str(args["text"]))
        elif kind == "html":
            host_clipboard.set_html(str(args["html"]), str(args.get("text") or ""))
        elif kind == "image":
            host_clipboard.set_image(_within_report(ctx, str(args["png"])))
        elif kind == "files":
            host_clipboard.set_files([_within_report(ctx, str(p)) for p in args["paths"]])
        else:
            raise StepError(f"host_clipboard: unknown kind {kind}")
    else:
        if kind == "text":
            wanted = args.get("equals")
            if "same_as" in args:
                samples = getattr(ctx, "_clipboard_samples", {})
                if args["same_as"] not in samples:
                    raise StepError("host_clipboard: same_as must identify a previously captured QA payload")
                wanted = samples[args["same_as"]]
            contains = args.get("contains")
            if wanted is None and contains is None:
                raise StepError("host_clipboard text assert requires equals, contains or same_as")
            def check_text():
                value = host_clipboard.get_text()
                return value == wanted if wanted is not None else str(contains) in value, value
            value = _poll(check_text, timeout, "text")
            record["value"] = value
        elif kind == "html":
            contains = str(args["contains"])
            record["value"] = _poll(lambda: (contains in host_clipboard.get_html(), host_clipboard.get_html()),
                                    timeout, f"html contains {contains!r}")
        elif kind == "image":
            reference = _within_report(ctx, str(args["png_equals"]))
            saved = ctx.case_dir / "host-clipboard-image.png"
            want = _image_digest(ctx, reference)

            def check() -> tuple[bool, Any]:
                host_clipboard.save_image(saved)
                got = _image_digest(ctx, saved)
                return (got.get("width") == want.get("width") and got.get("height") == want.get("height")
                        and got.get("rgb_sha256") == want.get("rgb_sha256"), got)

            record["value"] = _poll(check, timeout, "image pixels")
            record["reference"] = want
        elif kind == "files":
            names = [str(n) for n in args.get("names") or []]
            # Optional content oracle: the clipboard entry with the same name
            # as this local tree must hold identical relative paths and bytes.
            reference = _within_report(ctx, str(args["same_tree_as"])) if args.get("same_tree_as") else None
            expected_tree = _tree_digest(reference) if reference else None

            def check_files() -> tuple[bool, Any]:
                files = host_clipboard.get_files()
                found = {Path(f).name: Path(f) for f in files}
                ok = all(n in found for n in names) and bool(files)
                observed: Any = files
                if ok and reference is not None:
                    candidate = found.get(reference.name)
                    actual = _tree_digest(candidate) if candidate and candidate.exists() else None
                    observed = {"files": files, "tree": actual}
                    ok = actual == expected_tree
                return ok, observed

            record["value"] = _poll(check_files, timeout, f"file list with {names}")
            if expected_tree is not None:
                record["expected_tree"] = expected_tree
        else:
            raise StepError(f"host_clipboard: unknown kind {kind}")
    history = []
    if observations.exists():
        try:
            history = json.loads(observations.read_text(encoding="utf-8"))
        except ValueError:
            history = []
    history.append(record)
    observations.write_text(json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8")
    if failure:
        raise StepError(failure)
    if action == "quiet":
        return f"host_clipboard quiet: {record['changes']} change(s) in {record['seconds']:.0f}s"
    return f"host_clipboard {action} {kind} ok"


# --------------------------------------------------------------- host_make_tree

def _tree_digest(root: Path) -> dict[str, str | None]:
    """Relative ``/`` path → SHA-256 (``None`` for directories), root included."""
    import hashlib

    entries: dict[str, str | None] = {}
    base = root.parent
    for path in sorted([root, *root.rglob("*")] if root.is_dir() else [root]):
        relative = path.relative_to(base).as_posix()
        entries[relative] = None if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
    return entries


@_verb("host_make_tree")
def _do_host_make_tree(ctx: NativeStepContext, args: Any) -> str:
    """Create ``root`` with ``files`` ({relative path: UTF-8 text}) inside the
    case directory and record every entry's SHA-256 in ``<root>-tree.json``."""
    if not isinstance(args, dict) or "root" not in args or not isinstance(args.get("files"), dict):
        raise StepError("host_make_tree: expected {root, files: {relative path: text}}")
    root = _within_report(ctx, str(args["root"]))
    if root.exists():
        raise StepError(f"host_make_tree: {root} already exists")
    root.mkdir(parents=True)
    for relative, text in args["files"].items():
        target = _within_report(ctx, str(root / str(relative)))
        if not target.is_relative_to(root):
            raise StepError(f"host_make_tree: {relative} escapes {root}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(str(text).encode("utf-8"))
    digest = _tree_digest(root)
    (root.parent / f"{root.name}-tree.json").write_text(json.dumps(digest, indent=2, ensure_ascii=False),
                                                         encoding="utf-8")
    return f"created {len(digest)} entries under {root.name}"


# ------------------------------------------------------------- platform_choice

_PLATFORM_NAMES = {"Windows": "Windows", "Darwin": "macOS", "Linux": "Linux"}


@_verb("platform_choice")
def _do_platform_choice(ctx: NativeStepContext, args: Any) -> str:
    """Answer a dialog that exists only on some platforms.

    On ``platforms`` the ``dialog`` must become visible within ``timeout_sec``
    and ``click`` is pressed; elsewhere it must stay absent for ``absent_sec``.
    Both branches assert, so the prompt appearing on the wrong platform, or
    not appearing where it belongs, fails the step.
    """
    from .native_steps import _element_has_layout, _find_quiet, _wait_for

    if not isinstance(args, dict) or not {"platforms", "dialog", "click"} <= set(args):
        raise StepError("platform_choice: expected {platforms, dialog, click, timeout_sec?, absent_sec?}")
    platforms = {str(name) for name in args["platforms"]}
    current = _PLATFORM_NAMES.get(platform.system(), platform.system())
    dialog, button = str(args["dialog"]), str(args["click"])
    if current in platforms:
        _wait_for(ctx, {"selector": dialog, "timeout_sec": float(args.get("timeout_sec") or 30)})
        ctx.session.click(button)
        return f"{current}: answered {dialog} with {button}"
    deadline = time.time() + float(args.get("absent_sec") or 3)
    while time.time() < deadline:
        if _find_quiet(ctx, dialog) and _element_has_layout(ctx, dialog):
            raise StepError(f"platform_choice: {dialog} appeared on {current}; "
                            f"expected only on {sorted(platforms)}")
        time.sleep(0.25)
    return f"{current}: {dialog} stayed absent"


# ------------------------------------------------------------ assert_json_file

@_verb("assert_json_file")
def _do_assert_json_file(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "path" not in args or "expect" not in args:
        raise StepError("assert_json_file: expected {path, expect, timeout_sec?}")
    path = _within_report(ctx, str(args["path"]))
    timeout = float(args.get("timeout_sec") or 10)
    deadline = time.time() + timeout
    problems: list[str] = ["file missing"]
    while time.time() < deadline:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            problems = _check_expectations(data, args["expect"], "assert_json_file")
            if not problems:
                return f"{path.name} satisfies {sorted(args['expect'])}"
        except (OSError, ValueError) as exc:
            problems = [f"unreadable: {exc}"]
        time.sleep(0.25)
    raise StepError("; ".join(problems))


# ------------------------------------------------------------ rdp_canvas_click

@_verb("rdp_canvas_click")
def _do_rdp_canvas_click(ctx: NativeStepContext, args: Any) -> str:
    """Click remote desktop coordinate (x, y) inside the RDP client canvas."""
    if not isinstance(args, dict) or "x" not in args or "y" not in args:
        raise StepError("rdp_canvas_click: expected {x, y, selector?}")
    selector = str(args.get("selector") or '[data-testid="rdp-canvas"]')
    geometry = ctx.session.execute(
        "const c = document.querySelector(" + json.dumps(selector) + ");"
        "if (!c) return null; const r = c.getBoundingClientRect();"
        "return {left: r.left, top: r.top, width: r.width, height: r.height,"
        " desktopWidth: c.width, desktopHeight: c.height};"
    )
    if not isinstance(geometry, dict) or not geometry.get("width"):
        raise StepError(f"rdp_canvas_click: canvas {selector} not found or not laid out")
    sx = float(geometry["width"]) / float(geometry["desktopWidth"] or geometry["width"])
    sy = float(geometry["height"]) / float(geometry["desktopHeight"] or geometry["height"])
    vx = int(geometry["left"] + float(args["x"]) * sx)
    vy = int(geometry["top"] + float(args["y"]) * sy)
    ctx.session.request("POST", ctx.session.endpoint("/actions"), {"actions": [{
        "type": "pointer", "id": "rdp-canvas-pointer", "parameters": {"pointerType": "mouse"},
        "actions": [
            {"type": "pointerMove", "duration": 50, "x": vx, "y": vy, "origin": "viewport"},
            {"type": "pointerDown", "button": 0},
            {"type": "pause", "duration": 60},
            {"type": "pointerUp", "button": 0},
        ]}]})
    ctx.session.request("DELETE", ctx.session.endpoint("/actions"))
    return f"clicked desktop ({args['x']},{args['y']}) at viewport ({vx},{vy}) scale {sx:.3f}x{sy:.3f}"


# ------------------------------------------------------------------- save_text

@_verb("rdp_canvas_assert")
def _do_rdp_canvas_assert(ctx: NativeStepContext, args: Any) -> str:
    """Read decoded pixels and preserve the client view and quality evidence."""
    if not isinstance(args, dict) or not isinstance(args.get("points"), list) or not args["points"]:
        raise StepError("rdp_canvas_assert: expected {points: [{x,y,rgb,tolerance?}], artifact?, timeout_sec?}")
    selector = str(args.get("selector") or '[data-testid="rdp-canvas"]')
    points = args["points"]
    artifact = _within_report(ctx, str(args.get("artifact") or "client-pixels") + ".json")

    def observe() -> tuple[bool, Any]:
        result = ctx.session.execute(
            "const c=document.querySelector(" + json.dumps(selector) + ");"
            "if (!c || !c.width || !c.height) return null;"
            "const g=c.getContext('2d'); if (!g) return null;"
            "const points=" + json.dumps(points) + ";"
            "const pixels=points.map(p=>Array.from(g.getImageData(p.x,p.y,1,1).data));"
            "const q=document.querySelector('[data-testid=rdp-bar-quality]');"
            "return {width:c.width,height:c.height,pixels,quality_level:q?Number(q.getAttribute('data-level')):null};"
        )
        if not isinstance(result, dict):
            return False, result
        artifact.write_text(json.dumps(result, indent=2), encoding="utf-8")
        ok = all(len(pixel) == 4 and pixel[3] == 255
                   and all(abs(pixel[channel] - point["rgb"][channel]) <= int(point.get("tolerance", 24)) for channel in range(3))
                   for point, pixel in zip(points, result.get("pixels", []))) and len(result.get("pixels", [])) == len(points)
        return ok, result

    _poll(observe, float(args.get("timeout_sec") or 30), f"decoded client pixels in {artifact.name}")
    # Capture the actual WebView after the decoder's independent pixel oracle
    # succeeds, including the connection bar in the full-screen observation.
    ctx.session.screenshot(artifact.with_suffix(".png"))
    return f"decoded client pixel assertions passed; evidence {artifact.name}, {artifact.with_suffix('.png').name}"

@_verb("save_text")
def _do_save_text(ctx: NativeStepContext, args: Any) -> str:
    """Write an element's text into the report root (diagnostics, no assertion)."""
    if not isinstance(args, dict) or not args.get("selector") or not args.get("path"):
        raise StepError("save_text: expected {selector, path}")
    path = _within_report(ctx, str(args["path"]))
    text = ctx.session.text(str(args["selector"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return f"saved {len(text)} characters of {args['selector']} to {path.name}"
