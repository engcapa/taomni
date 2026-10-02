"""Own one mstsc process on the interactive CI desktop (Windows only)."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
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


def launch(rdp_file: Path, port: int) -> MstscProcess:
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
