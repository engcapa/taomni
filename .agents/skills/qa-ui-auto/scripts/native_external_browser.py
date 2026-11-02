"""Own only Linux browsers launched by a synthetic authorization QA case.

The real system opener/browser remains in use. Cleanup never identifies a
process solely by its name: it also requires the exact run-owned XDG roots,
no pre-case identity, and an unchanged kernel start time before every signal.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import time

BROWSERS = {"firefox", "firefox-bin", "chromium", "chromium-browser", "chrome", "google-chrome"}


def identity(pid: int, proc_root: Path) -> dict | None:
    try:
        entry = proc_root / str(pid)
        fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        executable = (entry / "exe").resolve(strict=True)
        return {"pid": pid, "started": fields[19], "executable": str(executable)}
    except (OSError, ValueError, IndexError):
        return None


def browsers(proc_root: Path) -> dict[int, dict]:
    result = {}
    for path in proc_root.iterdir():
        if path.name.isdecimal():
            current = identity(int(path.name), proc_root)
            if current and Path(current["executable"]).name in BROWSERS:
                result[current["pid"]] = current
    return result


def inherits_isolation(pid: int, expected: dict[str, str], proc_root: Path) -> bool:
    try:
        entries = (proc_root / str(pid) / "environ").read_bytes().split(b"\0")
    except OSError:
        return False
    # Do not retain environment contents, command arguments or authorization URLs.
    values = {}
    for entry in entries:
        name, separator, value = entry.partition(b"=")
        if separator and name.decode("utf-8", errors="replace") in expected:
            values[name.decode()] = value.decode("utf-8", errors="replace")
    return values == expected


class ExternalBrowserOwner:
    def __init__(self, report_root: Path, case_dir: Path, expected: dict[str, str],
                 proc_root: Path = Path("/proc")):
        root = report_root.resolve()
        if set(expected) != {"XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"}:
            raise RuntimeError("External browser cleanup requires all three native XDG roots")
        if any(not Path(value).resolve().is_relative_to(root) for value in expected.values()):
            raise RuntimeError("External browser cleanup refuses non-run-owned XDG roots")
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise RuntimeError("External browser cleanup requires the active native isolation environment")
        self.expected = expected
        self.proc_root = proc_root
        self.before = browsers(proc_root)
        self.path = case_dir / "native-external-browser-cleanup.json"
        self.record = {"platform": "Linux", "status": "pending", "closed": [], "excluded": []}
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.record, indent=2) + "\n", encoding="utf-8")

    def current_owned(self) -> list[dict]:
        owned = []
        for pid, current in browsers(self.proc_root).items():
            if self.before.get(pid) == current:
                continue
            if inherits_isolation(pid, self.expected, self.proc_root):
                owned.append(current)
            elif current not in self.record["excluded"]:
                self.record["excluded"].append(current)
        return owned

    def stop(self, timeout: float = 10) -> None:
        if self.record["status"] == "closed":
            return
        try:
            owned = self.current_owned()
            if not owned:
                raise RuntimeError("Authorization case left no independently identifiable owned browser")
            deadline = time.monotonic() + timeout
            signalled = set()
            while True:
                # A still-live claimed browser losing its environment proof is
                # a cleanup failure, never evidence that the browser exited.
                for pid, started, executable in signalled:
                    current = identity(pid, self.proc_root)
                    if (current == {"pid": pid, "started": started, "executable": executable}
                            and not inherits_isolation(pid, self.expected, self.proc_root)):
                        raise RuntimeError("Owned browser isolation became unreadable before exit")
                live = self.current_owned()
                if not live:
                    break
                for current in live:
                    token = (current["pid"], current["started"], current["executable"])
                    if token in signalled:
                        continue
                    # PID reuse or an environment change invalidates ownership.
                    if (identity(current["pid"], self.proc_root) != current
                            or not inherits_isolation(current["pid"], self.expected, self.proc_root)):
                        raise RuntimeError("External browser ownership changed before cleanup")
                    try:
                        os.kill(current["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        continue
                    signalled.add(token)
                    self.record["closed"].append(current)
                if time.monotonic() >= deadline:
                    raise RuntimeError("Owned authorization browser did not exit after termination request")
                time.sleep(0.05)
            self.record["status"] = "closed"
        except Exception as error:
            self.record.update(status="failed", error=str(error))
            raise
        finally:
            self.save()
