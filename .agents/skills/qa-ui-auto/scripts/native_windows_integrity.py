"""Read-only integrity guard for this run's Windows driver process tree.

A Low-labeled msedgedriver executable starts Low even from a Medium parent,
then starts Taomni at Low as well. WGC reports E_ACCESSDENIED although the
same QA binary captures normally when launched by the desktop. Never alter
ACLs, tokens or privacy policy here: reject the setup with an actionable error.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

from native_webdriver_transport import WebDriverError


def process_integrity(pid: int) -> int:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    security.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID,
                                            wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    security.GetSidSubAuthorityCount.argtypes = [wintypes.LPVOID]
    security.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    security.GetSidSubAuthority.argtypes = [wintypes.LPVOID, wintypes.DWORD]
    security.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)
    process = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    token = wintypes.HANDLE()
    try:
        if not security.OpenProcessToken(process, 8, ctypes.byref(token)):  # TOKEN_QUERY
            raise ctypes.WinError(ctypes.get_last_error())
        needed = wintypes.DWORD()
        security.GetTokenInformation(token, 25, None, 0, ctypes.byref(needed))  # TokenIntegrityLevel
        if not needed.value or needed.value > 65536:
            raise RuntimeError("invalid integrity token size")
        buffer = ctypes.create_string_buffer(needed.value)
        if not security.GetTokenInformation(token, 25, buffer, len(buffer), ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        # TOKEN_MANDATORY_LABEL starts with SID_AND_ATTRIBUTES.Sid.
        sid = ctypes.cast(buffer, ctypes.POINTER(wintypes.LPVOID)).contents.value
        count = security.GetSidSubAuthorityCount(sid)[0]
        if not count:
            raise RuntimeError("integrity SID has no authority")
        return int(security.GetSidSubAuthority(sid, count - 1)[0])
    finally:
        if token:
            kernel.CloseHandle(token)
        kernel.CloseHandle(process)


def process_created_at(pid: int) -> int:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    process = kernel.OpenProcess(0x1000, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel.CloseHandle(process)


def select_driver_processes(rows: list[tuple[int, int, str]], root_pid: int,
                            created_at=process_created_at) -> list[tuple[int, str]]:
    """Only the launcher/native adapter carry the QA app's inherited token.

    Toolhelp parent PIDs can refer to an older, exited process with a recycled
    PID. Browser renderers and unrelated OS sandbox processes are not adapters.
    Require both a driver role and a creation time after the actual parent.
    """
    if not any(pid == root_pid for pid, _, _ in rows):
        return []
    born = {root_pid: created_at(root_pid)}
    while True:
        added = False
        for pid, parent, name in rows:
            if pid in born or parent not in born or name.casefold() not in {"tauri-driver.exe", "msedgedriver.exe"}:
                continue
            created = created_at(pid)
            if created >= born[parent]:
                born[pid] = created
                added = True
        if not added:
            break
    return [(pid, name) for pid, _, name in rows if pid in born]


def owned_driver_processes(root_pid: int) -> list[tuple[int, str]]:
    class Entry(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD),
                    ("pid", wintypes.DWORD), ("heap", ctypes.c_size_t),
                    ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
                    ("parent", wintypes.DWORD), ("priority", wintypes.LONG),
                    ("flags", wintypes.DWORD), ("exe", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)  # SNAP_PROCESS
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows = []
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(Entry)
        present = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while present:
            rows.append((entry.pid, entry.parent, entry.exe))
            present = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return select_driver_processes(rows, root_pid)


def ensure_medium_driver_tree(root_pid: int) -> list[dict]:
    evidence = []
    try:
        for pid, name in owned_driver_processes(root_pid):
            level = process_integrity(pid)
            evidence.append({"pid": pid, "name": name, "integrityRid": level})
    except (OSError, RuntimeError) as error:
        raise WebDriverError(f"Cannot inspect owned Windows native driver integrity: {error}") from error
    if not evidence:
        raise WebDriverError("Owned Windows native driver tree disappeared before integrity validation")
    low = [row for row in evidence if row["integrityRid"] < 0x2000]
    if low:
        names = ", ".join(f'{row["name"]} PID {row["pid"]} (RID {row["integrityRid"]})' for row in low)
        raise WebDriverError(
            f"Native driver runs below Medium Integrity: {names}. Windows Graphics Capture may reject "
            "the QA child with 0x80070005 even when screen-capture permission is enabled. "
            "Check the configured driver's executable/directory mandatory label; use a verified driver "
            "in a normal tools directory, not a Low-labeled browser/report tree. "
            "No ACL, privacy setting or process token was changed."
        )
    return evidence
