"""Owned Linux bind-mount fault; never changes the parent filesystem policy."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess


def mount_record(target: Path):
    rows = []
    for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
        fields = line.split()
        path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
        if path == str(target):
            rows.append({"id": fields[0], "options": fields[5].split(","), "raw": line})
    if len(rows) > 1:
        raise RuntimeError("Refusing stacked mounts at the execution fixture")
    return rows[0] if rows else None


def is_noexec(target: Path) -> bool:
    return bool(os.statvfs(target).f_flag & os.ST_NOEXEC)


class NoExecBind:
    def __init__(self, target: Path, owner: Path):
        self.target, self.owner = target.absolute(), owner.absolute()
        self.mount_id = None

    def validate(self):
        if (self.owner.resolve(strict=True) != self.owner
                or self.target.resolve(strict=True) != self.target
                or self.target == self.owner or not self.target.is_relative_to(self.owner)
                or not self.target.is_dir()):
            raise RuntimeError("Noexec target must be an ordinary directory inside the owned run")

    def command(self, *args):
        return subprocess.run(["sudo", "-n", *args], check=True, capture_output=True,
                              text=True, timeout=20)

    def block(self):
        self.validate()
        if self.mount_id is not None or mount_record(self.target) or is_noexec(self.target):
            raise RuntimeError("Noexec fixture requires an executable, unmounted target")
        self.command("mount", "--bind", "--", str(self.target), str(self.target))
        try:
            record = mount_record(self.target)
            if record is None:
                raise RuntimeError("Bind mount succeeded without an observable mount identity")
        except BaseException:
            # The bind above succeeded and the target had no previous mount.
            # Clean up even if reading /proc failed before recording its ID.
            self.command("umount", "--", str(self.target))
            raise
        self.mount_id = record["id"]
        try:
            self.command("mount", "-o", "remount,bind,noexec,nosuid,nodev", "--", str(self.target))
            if not is_noexec(self.target):
                raise RuntimeError("Kernel did not apply the requested noexec policy")
            return mount_record(self.target)
        except BaseException:
            self.restore()
            raise

    def restore(self):
        if self.mount_id is None:
            return
        self.validate()
        record = mount_record(self.target)
        if record is None or record["id"] != self.mount_id:
            raise RuntimeError("Noexec fixture mount identity changed; refusing to unmount")
        self.command("umount", "--", str(self.target))
        self.mount_id = None
        if mount_record(self.target) is not None or is_noexec(self.target):
            raise RuntimeError("Execution fixture did not return to the original mount policy")
