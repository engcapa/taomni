"""Read exact Darwin process identities and adopt an app-created QA child.

No process is launched here. Environment reads retain only the requested QA
isolation keys; command arguments and other environment values are never logged.
"""
from __future__ import annotations

import ctypes
import errno
import os
import signal
import struct
import subprocess
import time


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
        "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        "nfiles", "pgid", "jobc", "tdev", "tpgid")]
    _fields_ += [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64),
                ("start_usec", ctypes.c_uint64)]


def identity(pid: int) -> dict | None:
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                     ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    info = BsdInfo()
    ctypes.set_errno(0)
    size = library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size == 0 and ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
        return None
    if size != ctypes.sizeof(info):
        raise RuntimeError("Cannot observe the complete Darwin process identity")
    if info.pid != pid or info.uid != os.getuid():
        raise RuntimeError("Darwin process identity is not owned by this QA user")
    if info.status == 5:  # SZOMB: no address space or live bridge remains.
        return None
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    path = ctypes.create_string_buffer(4096)
    ctypes.set_errno(0)
    if library.proc_pidpath(pid, path, len(path)) <= 0:
        if ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
            return None
        raise RuntimeError("Cannot observe the Darwin process executable")
    return {"pid": pid, "start_sec": info.start_sec, "start_usec": info.start_usec,
            "executable": os.fsdecode(path.value)}


def parse_environment(payload: bytes, keys: set[str]) -> dict[str, str]:
    if len(payload) < 4:
        raise RuntimeError("Incomplete Darwin process arguments")
    argc = struct.unpack_from("=i", payload)[0]
    if not 0 < argc < 8192:
        raise RuntimeError("Invalid Darwin argument count")
    _, separator, remainder = payload[4:].partition(b"\0")
    if not separator:
        raise RuntimeError("Incomplete Darwin executable path")
    remainder = remainder.lstrip(b"\0")
    for _ in range(argc):
        _, separator, remainder = remainder.partition(b"\0")
        if not separator:
            raise RuntimeError("Incomplete Darwin argument list")
    result = {}
    for entry in remainder.split(b"\0"):
        name, separator, value = entry.partition(b"=")
        key = os.fsdecode(name)
        if separator and key in keys:
            if key in result:
                raise RuntimeError("Duplicate QA isolation environment key")
            result[key] = os.fsdecode(value)
    return result


def environment(pid: int, keys: set[str]) -> dict[str, str]:
    library = ctypes.CDLL(None, use_errno=True)
    library.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                              ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                              ctypes.c_void_p, ctypes.c_size_t]
    library.sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, exact PID.
    length = ctypes.c_size_t(0)
    if library.sysctl(mib, 3, None, ctypes.byref(length), None, 0) != 0:
        raise RuntimeError("Cannot size the owned Darwin process environment")
    if not 4 <= length.value <= 4 * 1024 * 1024:
        raise RuntimeError("Invalid Darwin process environment length")
    buffer = ctypes.create_string_buffer(length.value)
    if library.sysctl(mib, 3, buffer, ctypes.byref(length), None, 0) != 0:
        raise RuntimeError("Cannot read the owned Darwin process environment")
    return parse_environment(buffer.raw[:length.value], keys)


def listener_pid(port: int) -> int | None:
    result = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", f"-iTCP:{port}",
                             "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=5)
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return None
    if result.returncode:
        raise RuntimeError("Cannot observe the owned QA bridge listener")
    try:
        pids = {int(line) for line in result.stdout.splitlines()}
    except ValueError as error:
        raise RuntimeError("Invalid QA bridge listener identity") from error
    if len(pids) != 1 or min(pids) <= 0:
        raise RuntimeError("QA bridge must have exactly one listener process")
    return pids.pop()


class AdoptedProcess:
    """Cleanup ownership with kernel PID/start-time checks, without inventing exit codes.

    The restarted process is no longer Python's child. Its actual exit status
    cannot be reaped here; callers requiring exit=0 must reject the explicit
    unavailable marker. The native driver's teardown only needs disappearance.
    """
    EXIT_UNAVAILABLE = "process gone; exit status unavailable (adopted process)"

    def __init__(self, expected: dict, inspect=None):
        self.expected = dict(expected)
        self.pid = expected["pid"]
        self.returncode = None
        self.inspect = inspect

    def poll(self):
        current = (self.inspect or identity)(self.pid)
        if current is None or current != self.expected:
            self.returncode = self.EXIT_UNAVAILABLE
        return self.returncode

    def wait(self, timeout=None):
        end = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if end is not None and time.monotonic() >= end:
                raise subprocess.TimeoutExpired("adopted QA process", timeout)
            time.sleep(.05)
        return self.returncode

    def send_signal(self, value):
        if (self.inspect or identity)(self.pid) == self.expected:
            try:
                os.kill(self.pid, value)
            except ProcessLookupError:
                pass

    def terminate(self):
        self.send_signal(signal.SIGTERM)

    def kill(self):
        self.send_signal(9)  # Darwin SIGKILL; pure unit contracts also run on Windows.
