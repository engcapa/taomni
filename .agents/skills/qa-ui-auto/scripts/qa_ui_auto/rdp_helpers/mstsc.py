"""Own one mstsc process on the interactive CI desktop (Windows only)."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
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


class ShellExecuteInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("fMask", wintypes.ULONG),
               ("hwnd", wintypes.HWND), ("lpVerb", wintypes.LPCWSTR),
               ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
               ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int),
               ("hInstApp", wintypes.HINSTANCE), ("lpIDList", ctypes.c_void_p),
               ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
               ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE),
               ("hProcess", wintypes.HANDLE)]


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


def launch_create(rdp_file: Path, port: int) -> MstscProcess:
    """Direct Win32 launch, retained for the hosted startup diagnostic."""
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


def launch(rdp_file: Path, port: int) -> MstscProcess:
    """Use the Windows shell's normal GUI launch and retain the process handle."""
    api = _kernel()
    api.GetProcessId.argtypes = [wintypes.HANDLE]
    api.GetProcessId.restype = wintypes.DWORD
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    shell.ShellExecuteExW.argtypes = [ctypes.POINTER(ShellExecuteInfo)]
    shell.ShellExecuteExW.restype = wintypes.BOOL
    ole = ctypes.WinDLL("ole32")
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoUninitialize.argtypes = []
    ole.CoUninitialize.restype = None
    initialized = ole.CoInitializeEx(None, 6)  # apartment threaded, disable OLE1 DDE
    if initialized not in (0, 1, -2147417850):  # S_OK, S_FALSE, RPC_E_CHANGED_MODE
        raise OSError(f"mstsc shell COM initialization failed: {initialized}")
    executable = Path(os.environ["SystemRoot"]) / "System32" / "mstsc.exe"
    info = ShellExecuteInfo(
        cbSize=ctypes.sizeof(ShellExecuteInfo),
        fMask=0x40 | 0x100,  # SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
        lpVerb="open", lpFile=str(executable), nShow=1,
        lpParameters=subprocess.list2cmdline([str(rdp_file.resolve()), f"/v:127.0.0.1:{port}"]),
        lpDirectory=str(rdp_file.resolve().parent),
    )
    try:
        if not shell.ShellExecuteExW(ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if initialized in (0, 1):
            ole.CoUninitialize()
    if not info.hProcess:
        raise OSError("mstsc shell launch did not return an owned process")
    pid = api.GetProcessId(info.hProcess)
    if not pid:
        api.CloseHandle(info.hProcess)
        raise ctypes.WinError(ctypes.get_last_error())
    return MstscProcess(api, info.hProcess, pid)


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
    for name, launcher in (("create", launch_create), ("shell", launch)):
        target = directory / name
        target.mkdir(exist_ok=True)
        process = None
        facts = {"launch_api": name, "tcp_initiated": False}
        with socket.socket() as listener:
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
                process = launcher(rdp_file, port)
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
