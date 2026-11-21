"""Read-only native proof of a module host's writer lease.

The fixed path belongs to the verified isolated profile. Briefly attempting an
exclusive OS lock neither creates files nor changes registry/application data.
Profile-use ownership itself is proven by the separate real-process gate: a
running core also holds that shared lock and cannot identify its holder here.
"""
from __future__ import annotations

import errno
import os
from pathlib import Path
import stat

from .module_retained_observation import ordinary
from .steps import StepError


def _exclusive(descriptor: int) -> bool:
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        return True
    except OSError as error:
        if error.errno in {errno.EACCES, errno.EAGAIN}:
            return False
        raise


def writer_lease(plugins: Path, *, enabled: bool, slug: str = "hello-plugin") -> dict:
    """No YAML path, PID text or renderer claim can satisfy this observation."""
    ordinary(plugins, directory=True)
    path = plugins.parent / ".profile-locks/plugins" / f"{slug}.lock"
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if enabled:
            raise StepError(f"Running {slug} host has no native writer lease file") from None
        return {"exists": False, "held": False}
    ordinary(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise StepError("Native writer lease file is not an ordinary profile file")
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        acquired = _exclusive(descriptor)
    finally:
        os.close(descriptor)
    if acquired == enabled:
        raise StepError("Enabled host does not own its writer lease" if enabled
                        else "Inactive host still holds its native writer lease")
    return {"exists": True, "held": not acquired, "method": "OS nonblocking exclusive lock"}
