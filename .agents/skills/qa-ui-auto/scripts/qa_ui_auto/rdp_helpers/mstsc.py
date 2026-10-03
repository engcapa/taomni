"""Own one mstsc process on the interactive CI desktop (Windows only)."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from contextlib import ExitStack, contextmanager, nullcontext
import json
import os
from pathlib import Path
import shutil
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
def _registry_value(root, path, name, value, *, value_type=None):
    """Temporarily set one value without deleting unrelated registry state."""
    import winreg
    with winreg.CreateKeyEx(root, path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        try:
            previous = winreg.QueryValueEx(key, name)
        except FileNotFoundError:
            previous = None
        winreg.SetValueEx(key, name, 0, winreg.REG_DWORD if value_type is None else value_type, value)
    try:
        yield
    finally:
        with winreg.CreateKeyEx(root, path, 0, winreg.KEY_WRITE) as key:
            if previous is None:
                winreg.DeleteValue(key, name)
            else:
                winreg.SetValueEx(key, name, 0, previous[1], previous[0])


@contextmanager
def crash_reporting(directory: Path):
    """Keep an owned client's Windows Error Reporting minidump on hosted CI."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        yield
        return
    import winreg
    target = directory.resolve() / "mstsc-crash"
    target.mkdir(exist_ok=True)
    path = r"SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\mstsc.exe"
    with ExitStack() as restore:
        restore.enter_context(_registry_value(winreg.HKEY_LOCAL_MACHINE, path,
                                              "DumpFolder", str(target), value_type=winreg.REG_EXPAND_SZ))
        restore.enter_context(_registry_value(winreg.HKEY_LOCAL_MACHINE, path, "DumpType", 1))
        restore.enter_context(_registry_value(winreg.HKEY_LOCAL_MACHINE, path, "DumpCount", 1))
        yield


@contextmanager
def crash_capture(process: MstscProcess, directory: Path):
    """Attach ProcDump to the owned hosted PID, including direct process exits."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        yield
        return
    executable = os.environ.get("QA_MSTSC_PROCDUMP")
    if not executable or not Path(executable).is_file():
        raise RuntimeError("hosted mstsc crash capture requires QA_MSTSC_PROCDUMP")
    target = directory / "mstsc-crash" / f"owned-{process.pid}"
    target.mkdir(parents=True, exist_ok=True)
    with (directory / "mstsc-procdump.log").open("wb") as output:
        monitor = subprocess.Popen(
            [executable, "-accepteula", "-mm", "-e", "1", "-f", "C0000005", "-t", "-n", "3", str(process.pid), str(target)],
            stdout=output, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            yield
        finally:
            # The caller stops the client first. Allow its crash/exit dump to
            # finish before collecting diagnostics or restoring host state.
            try:
                monitor.wait(timeout=15)
            except subprocess.TimeoutExpired:
                monitor.terminate()
                try:
                    monitor.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    monitor.kill()
                    monitor.wait(timeout=5)


@contextmanager
def heap_verification():
    """Catch the corrupting write in the disposable hosted reference client."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        yield
        return
    import winreg
    executable = os.environ.get("QA_MSTSC_GFLAGS")
    if not executable or not Path(executable).is_file():
        raise RuntimeError("hosted mstsc heap verification requires QA_MSTSC_GFLAGS")
    path = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\mstsc.exe"
    names = ("GlobalFlag", "PageHeapFlags", "VerifierFlags", "VerifierDlls", "StackTraceDatabaseSizeInMB")
    previous = {}
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
        for name in names:
            try:
                previous[name] = winreg.QueryValueEx(key, name)
            except FileNotFoundError:
                previous[name] = None
    try:
        subprocess.run([executable, "/p", "/enable", "mstsc.exe", "/full"],
                       capture_output=True, check=True, timeout=30,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        yield
    finally:
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_WRITE) as key:
            for name in names:
                old = previous[name]
                if old is None:
                    try:
                        winreg.DeleteValue(key, name)
                    except FileNotFoundError:
                        pass
                else:
                    winreg.SetValueEx(key, name, 0, old[1], old[0])


def crash_diagnostics(process: MstscProcess, directory: Path) -> None:
    """Collect the owned PID's Application Error and optional dump stack."""
    script = r'''
$events = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000;
  StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue)
$owned = foreach ($event in $events) {
  $xml = [xml]$event.ToXml()
  $data = @{}
  foreach ($field in $xml.Event.EventData.Data) { $data[[string]$field.Name] = [string]$field.'#text' }
  if ($data.AppName -ieq 'mstsc.exe' -and $data.ProcessId) {
    $pidValue = if ($data.ProcessId.StartsWith('0x')) {
      [Convert]::ToInt64($data.ProcessId.Substring(2),16)
    } else { [long]$data.ProcessId }
    if ($pidValue -eq [long]$env:QA_MSTSC_PID) {
      [pscustomobject]@{time=$event.TimeCreated.ToString('o'); id=$event.Id; data=$data}
    }
  }
}
ConvertTo-Json -InputObject @($owned) -Depth 5
'''
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            env={**os.environ, "QA_MSTSC_PID": str(process.pid)},
                            capture_output=True, text=True, timeout=30)
    (directory / "mstsc-application-error.json").write_text(result.stdout, encoding="utf-8")
    if result.stderr:
        (directory / "mstsc-application-error.txt").write_text(result.stderr, encoding="utf-8")
    dumps = list((directory / "mstsc-crash").glob(f"mstsc.exe.{process.pid}.dmp"))
    dumps.extend((directory / "mstsc-crash" / f"owned-{process.pid}").glob("*.dmp"))
    cdb = os.environ.get("QA_MSTSC_CDB") or shutil.which("cdb")
    if not cdb:
        candidate = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits/10/Debuggers/x64/cdb.exe"
        if candidate.is_file():
            cdb = str(candidate)
    if dumps and cdb:
        stacks = []
        for dump in sorted(dumps):
            result = subprocess.run([cdb, "-z", str(dump), "-c", ".symfix; .exr -1; .ecxr; k; q"],
                                    capture_output=True, text=True, timeout=90)
            stacks.append(f"Dump: {dump.name}\n{result.stdout}{result.stderr}")
            (directory / "mstsc-crash-stack.txt").write_text("\n".join(stacks), encoding="utf-8")


@contextmanager
def file_launch_consent():
    """Prepare and restore the disposable runner's loopback RDP-file launch.

    The April 2026 resource dialog ignores the per-host LocalDevices setting.
    Microsoft's WindowsProtocolTestSuites uses this dialog-version policy to
    restore that setting's behavior for unattended protocol tests. Preauthorize
    only 127.0.0.1; the owned RDP file still explicitly limits redirections.
    These settings precede TCP, authentication and server-certificate checks.
    Never change a developer's Windows account or machine policy.
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        yield
        return
    import winreg
    client = r"Software\Microsoft\Terminal Server Client"
    policy = r"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client"
    with ExitStack() as restore:
        restore.enter_context(_registry_value(winreg.HKEY_CURRENT_USER, client,
                                              "RdpLaunchConsentAccepted", 1))
        restore.enter_context(_registry_value(winreg.HKEY_LOCAL_MACHINE, policy,
                                              "RedirectionWarningDialogVersion", 1))
        restore.enter_context(_registry_value(winreg.HKEY_CURRENT_USER, client + r"\LocalDevices",
                                              "127.0.0.1", 0x4C))
        yield


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
                "redirectprinters:i:0\r\nredirectsmartcards:i:0\r\nredirectwebauthn:i:0\r\n"
                "redirectclipboard:i:1\r\ndisableconnectionsharing:i:1\r\n",
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
