"""Own only Linux browsers launched by a synthetic authorization QA case.

The real system opener/browser remains in use. Cleanup never identifies a
process solely by its name: it requires a case-private browser profile (or
legacy inherited run-owned XDG roots), no pre-case identity, and unchanged
kernel start time before every signal.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
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


def owns_profile(pid: int, profile: Path | None, proc_root: Path,
                 launch_record: Path | None = None) -> bool:
    if profile is None:
        return False
    try:
        args = (proc_root / str(pid) / "cmdline").read_bytes().split(b"\0")
    except OSError:
        return False
    target = str(profile).encode()
    if (b"--user-data-dir=" + target in args
            or any(arg in (b"--profile", b"-profile") and index + 1 < len(args)
                   and args[index + 1] == target for index, arg in enumerate(args))):
        return True
    # Chromium replaces argv with one unquoted, space-joined process title.
    # Such a title loses argument boundaries: do not trust a profile-looking
    # substring alone. Require this launcher's exact PID + kernel birth AND
    # a whitespace-delimited exact profile flag in the observed title.
    if (launch_record is None or len([arg for arg in args if arg]) != 1
            or any(character.isspace() for character in str(profile))):
        return False
    try:
        launch = json.loads(launch_record.read_text())
        current = identity(pid, proc_root)
    except (OSError, ValueError):
        return False
    if (not isinstance(launch, dict) or not current or Path(current["executable"]).name not in BROWSERS
            or launch.get("launched") is not True or launch.get("pid") != pid
            or launch.get("started") != current["started"]
            or launch.get("profile") != str(profile)):
        return False
    flag = rb"(?:^|[ \t])--user-data-dir=" + re.escape(target) + rb"(?=[ \t]|$)"
    return re.search(flag, args[0]) is not None


class ExternalBrowserOwner:
    def __init__(self, report_root: Path, case_dir: Path, expected: dict[str, str],
                 proc_root: Path = Path("/proc"), profile: Path | None = None,
                 launch_record: Path | None = None):
        root = report_root.resolve()
        if set(expected) != {"XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"}:
            raise RuntimeError("External browser cleanup requires all three native XDG roots")
        if any(not Path(value).resolve().is_relative_to(root) for value in expected.values()):
            raise RuntimeError("External browser cleanup refuses non-run-owned XDG roots")
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise RuntimeError("External browser cleanup requires the active native isolation environment")
        if profile is not None and (
                not profile.resolve().is_relative_to(Path(expected["XDG_CACHE_HOME"]).resolve())
                or not (profile / ".taomni-qa-browser").is_file()):
            raise RuntimeError("External browser profile must be inside the run-owned cache")
        if launch_record is not None and (
                profile is None or launch_record != case_dir.resolve() / "authorization-browser" / "launch.json"
                or launch_record.resolve() != launch_record
                or not launch_record.resolve().is_relative_to(root)):
            raise RuntimeError("External browser launch record must be inside the owned case")
        self.launch_record = launch_record
        self.expected = expected
        self.profile = profile.resolve() if profile is not None else None
        self.proc_root = proc_root
        self.before = browsers(proc_root)
        self.path = case_dir / "native-external-browser-cleanup.json"
        self.record = {"platform": "Linux", "status": "pending", "closed": [], "excluded": [],
                       "ownership": "private-profile" if self.profile is not None else "inherited-xdg",
                       "profile": str(self.profile) if self.profile is not None else None}
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.record, indent=2) + "\n", encoding="utf-8")

    def proves_ownership(self, pid: int) -> bool:
        return (owns_profile(pid, self.profile, self.proc_root, self.launch_record) if self.profile is not None
                else inherits_isolation(pid, self.expected, self.proc_root))

    def current_owned(self) -> list[dict]:
        owned = []
        for pid, current in browsers(self.proc_root).items():
            if self.before.get(pid) == current:
                continue
            if self.proves_ownership(pid):
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
                            and not self.proves_ownership(pid)):
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
                            or not self.proves_ownership(current["pid"])):
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
