"""Observe host bytes without blocking the application's atomic file replacement."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re

from .deadline import budget_time as time
from .steps import StepError


@contextmanager
def open_observation(path: Path):
    if os.name != "nt":
        with path.open("rb") as stream:
            yield stream
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    # Python's normal file open denies DELETE sharing. Polling a disk hash
    # immediately after Ctrl+S can then make the app's MoveFileExW fail with
    # ERROR_ACCESS_DENIED. Share replacement while retaining this exact open
    # file's bytes; the next poll observes a newly published file.
    handle = kernel.CreateFileW(str(path), 0x80000000, 0x1 | 0x2 | 0x4,
                                None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    with os.fdopen(descriptor, "rb") as stream:
        yield stream


def assert_file_sha256(_ctx, args):
    if not isinstance(args, dict) or not {"path", "equals"} <= set(args):
        raise StepError("assert_file_sha256: expected {path, equals, timeout_sec?}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["equals"]).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise StepError("assert_file_sha256: equals must be a lowercase SHA-256 hex digest")
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    actual = "missing"
    while time.time() < deadline:
        try:
            with open_observation(path) as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual == expected:
                return f"host byte SHA-256 verified: {actual}"
        except FileNotFoundError:
            actual = "missing"
        time.sleep(0.25)
    raise StepError(
        f"assert_file_sha256: {path} hash {actual!r} != {expected!r} after {timeout}s"
    )
