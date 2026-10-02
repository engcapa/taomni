"""Own one mstsc process on the interactive CI desktop (Windows only)."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from contextlib import contextmanager, nullcontext
import json
import os
from pathlib import Path
import subprocess


class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
               ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
               ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
               ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
               ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
               ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
               ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
               ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE),
               ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
               ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


class MstscProcess:
    def __init__(self, api, handle, pid):
        self.api, self.handle, self.pid = api, handle, pid

    def poll(self):
        code = wintypes.DWORD()
        if not self.api.GetExitCodeProcess(self.handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return None if code.value == 259 else code.value  # STILL_ACTIVE

    def terminate(self):
        if not self.api.TerminateProcess(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    kill = terminate

    def wait(self, timeout=None):
        millis = 0xFFFFFFFF if timeout is None else int(timeout * 1000)
        result = self.api.WaitForSingleObject(self.handle, millis)
        if result == 258:  # WAIT_TIMEOUT
            raise subprocess.TimeoutExpired("mstsc.exe", timeout)
        if result != 0:
            raise ctypes.WinError(ctypes.get_last_error())
        return self.poll()

    def close(self):
        if self.handle is not None:
            self.api.CloseHandle(self.handle)
            self.handle = None


def _kernel():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p,
                                  ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.LPCWSTR,
                                  ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)]
    api.CreateProcessW.restype = wintypes.BOOL
    for name, types in {
        "CloseHandle": [wintypes.HANDLE],
        "GetExitCodeProcess": [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)],
        "TerminateProcess": [wintypes.HANDLE, wintypes.UINT],
        "WaitForSingleObject": [wintypes.HANDLE, wintypes.DWORD],
    }.items():
        function = getattr(api, name)
        function.argtypes = types
        function.restype = wintypes.DWORD if name == "WaitForSingleObject" else wintypes.BOOL
    return api


def launch(rdp_file: Path, port: int) -> MstscProcess:
    """Launch the owned client on the interactive Win32 desktop."""
    api = _kernel()
    executable = Path(os.environ["SystemRoot"]) / "System32" / "mstsc.exe"
    command = ctypes.create_unicode_buffer(subprocess.list2cmdline([
        str(executable), str(rdp_file.resolve()), f"/v:127.0.0.1:{port}"]))
    startup = StartupInfo(cb=ctypes.sizeof(StartupInfo), lpDesktop=r"winsta0\default",
                          dwFlags=1, wShowWindow=1)  # STARTF_USESHOWWINDOW, SW_SHOWNORMAL
    info = ProcessInfo()
    # Python's subprocess.STARTUPINFO ignores lpDesktop. Pass it to Win32
    # directly; inherit neither a hidden desktop nor runner standard handles.
    if not api.CreateProcessW(str(executable), command, None, None, False, 0,
                              None, str(rdp_file.resolve().parent),
                              ctypes.byref(startup), ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    api.CloseHandle(info.hThread)
    return MstscProcess(api, info.hProcess, info.dwProcessId)


@contextmanager
def file_launch_consent():
    """Restore the disposable hosted account's first RDP-file launch setting.

    This only handles the initial file-opening notice, before any TCP traffic.
    Authentication and server-certificate validation remain the mstsc settings
    in the owned RDP file. Never change a developer's Windows account.
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        yield
        return
    import winreg
    path = r"Software\Microsoft\Terminal Server Client"
    value = "RdpLaunchConsentAccepted"
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        try:
            previous = winreg.QueryValueEx(key, value)
        except FileNotFoundError:
            previous = None
        winreg.SetValueEx(key, value, 0, winreg.REG_DWORD, 1)
    try:
        yield
    finally:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_WRITE) as key:
            if previous is None:
                winreg.DeleteValue(key, value)
            else:
                winreg.SetValueEx(key, value, 0, previous[1], previous[0])


def diagnose(process: MstscProcess, directory: Path) -> None:
    """Record window ownership and wait states without exposing credentials."""
    script = r'''
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class QaMstscWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static object[] List(uint pid) {
    var result = new List<object>();
    EnumWindows((h,p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid) {
        Rect r; GetWindowRect(h, out r);
        var title = new StringBuilder(512); var cls = new StringBuilder(256);
        GetWindowText(h,title,title.Capacity); GetClassName(h,cls,cls.Capacity);
        result.Add(new { hwnd=h.ToInt64(), visible=IsWindowVisible(h), title=title.ToString(),
          windowClass=cls.ToString(), x=r.Left, y=r.Top, width=r.Right-r.Left, height=r.Bottom-r.Top });
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$p = Get-Process -Id ([int]$env:QA_MSTSC_PID) -ErrorAction Stop
$threads = @($p.Threads | ForEach-Object {
  [pscustomobject]@{id=$_.Id; state=[string]$_.ThreadState;
    waitReason=$(if ($_.ThreadState -eq 'Wait') { [string]$_.WaitReason } else { $null })}
})
[pscustomobject]@{pid=$p.Id; sessionId=$p.SessionId; mainWindow=$p.MainWindowHandle.ToInt64();
  cpu=$p.CPU; windows=@([QaMstscWindows]::List([uint32]$p.Id)); threads=$threads} | ConvertTo-Json -Depth 5
'''
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            env={**os.environ, "QA_MSTSC_PID": str(process.pid)},
                            capture_output=True, text=True, timeout=30)
    (directory / "mstsc-windows.json").write_text(result.stdout, encoding="utf-8")
    if result.returncode:
        (directory / "mstsc-windows-error.txt").write_text(result.stderr, encoding="utf-8")


def preflight(directory: Path) -> None:
    """Hosted-only startup probe; this does not replace the mstsc interop case."""
    import socket
    from types import SimpleNamespace
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("mstsc startup probe requires the hosted Windows desktop")
    from qa_ui_auto.rdp_steps import _capture_mstsc
    directory.mkdir(parents=True, exist_ok=True)
    for name, consent in (("initial", nullcontext()), ("fixture", file_launch_consent())):
        target = directory / name
        target.mkdir(exist_ok=True)
        process = None
        facts = {"launch_api": name, "tcp_initiated": False}
        with consent, socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(20)
            port = listener.getsockname()[1]
            rdp_file = target / "startup.rdp"
            rdp_file.write_text(
                f"full address:s:127.0.0.1:{port}\r\nscreen mode id:i:1\r\n"
                "desktopwidth:i:1024\r\ndesktopheight:i:768\r\nauthentication level:i:0\r\n"
                "redirectprinters:i:0\r\nredirectsmartcards:i:0\r\ndisableconnectionsharing:i:1\r\n",
                encoding="utf-16", newline="")
            try:
                process = launch(rdp_file, port)
                try:
                    connection, _ = listener.accept()
                    with connection:
                        facts["tcp_initiated"] = True
                except TimeoutError:
                    pass
                diagnose(process, target)
                try:
                    _capture_mstsc(SimpleNamespace(case_dir=target), process, {"snapshot": "startup.png"})
                except Exception as error:
                    facts["capture_error"] = str(error)
            except Exception as error:
                facts["launch_error"] = str(error)
            finally:
                if process is not None:
                    try:
                        if process.poll() is None:
                            process.terminate()
                        process.wait(timeout=10)
                    finally:
                        process.close()
        (target / "startup.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
        print(json.dumps(facts), flush=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", type=Path, required=True)
    preflight(parser.parse_args().preflight)
