"""Observe the actual bridge launched by the QA desktop during first-use approval."""

import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess

from .deadline import budget_time as time, remaining_timeout
from .fixtures.backup_policy import isolated_data_root
from .fixtures.sockscap_redirector import CASE_ID, EXECUTABLE
from .module_profile_observation import writer_lease
from .steps import StepError


def rows():
    raw = subprocess.check_output(["/bin/ps", "-axww", "-o", "pid=,ppid=,command="],
                                  text=True, errors="replace", timeout=remaining_timeout(5))
    result = {}
    for line in raw.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            result[int(parts[0])] = (int(parts[1]), parts[2])
    return result


def executable(pid):
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")
    buf = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, buf, ctypes.sizeof(buf)) <= 0:
        return None
    return Path(os.fsdecode(buf.value)).resolve()


def pending(processes, core, host_path):
    for pid, (parent, args) in processes.items():
        if parent != core or " --sockscap-redirector-bridge " not in args:
            continue
        owner = re.search(r" --module-host ([1-9]\d*):([1-9]\d*) ", args)
        sockets = re.search(r" --provider-socket (/tmp/taomni-redirector-provider-[0-9a-f]{32}\.sock)"
                            r" --flow-socket (/tmp/taomni-redirector-flow-[0-9a-f]{32}\.sock) ", args)
        if not owner or not sockets or not args.endswith(f" --parent-pid {core}"):
            raise StepError("The bridge did not receive separate core and module identities and sockets")
        host = int(owner[1])
        if (executable(pid) != host_path or executable(host) != host_path
                or processes.get(host, (None,))[0] != core):
            raise StepError("The bridge or its owner did not execute the installed module")
        for launcher, (ppid, _) in processes.items():
            if ppid == pid and executable(launcher) == EXECUTABLE.resolve():
                paths = [Path(path) for path in sockets.groups()]
                if all(path.is_socket() and stat.S_IMODE(path.stat().st_mode) == 0o600 for path in paths):
                    return {"core": core, "host": host, "hostStartMicros": int(owner[2]), "bridge": pid,
                            "launcher": launcher, "providerSocket": str(paths[0]), "flowSocket": str(paths[1])}
    return None


def run(ctx, phase):
    fixture = ctx.fixture_context
    core = getattr(ctx.session, "owned_app_pid", None)
    if (phase not in {"pending", "disabled"} or fixture.case_id != CASE_ID or platform.system() != "Darwin"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or type(core) is not int):
        raise StepError("Redirector observation requires its owned macOS desktop and signed native case")
    profile = isolated_data_root(fixture)
    journal = profile / "plugins/sockscap/recovery.json"
    legacy_journal = profile / "sockscap/recovery.json"
    host_path = Path(fixture.values["sockscap_signed_host"])
    signed = fixture.signed_sockscap
    with host_path.open("rb") as binary:
        if hashlib.file_digest(binary, "sha256").hexdigest() != signed["hostSha256"]:
            raise StepError("Installed SocksCap host differs from its signed archive")
    result = {"sourceSha": signed["sourceSha"], "packageSha256": signed["sha256"],
              "hostSha256": signed["hostSha256"], "runnerImage": os.environ.get("ImageVersion"),
              "journalPath": journal.relative_to(profile).as_posix(),
              "phase": phase, "passed": False}
    before_path = ctx.case_dir / "redirector-pending.json"
    before = json.loads(before_path.read_text()) if phase == "disabled" else None
    deadline = time.monotonic() + remaining_timeout(35)
    try:
        while time.monotonic() < deadline:
            if legacy_journal.exists():
                raise StepError("The signed capture wrote a journal in the legacy directory")
            processes = rows()
            if executable(core) != ctx.session.application.resolve():
                raise StepError("The original QA desktop exited or changed executable")
            if phase == "pending":
                observed = pending(processes, core, host_path.resolve())
                if observed and journal.is_file():
                    saved = json.loads(journal.read_text())
                    if saved["phase"] != "preparing" or saved["pid"] != core or saved["clean"]:
                        raise StepError("The original desktop must still be preparing before scope activation")
                    result.update(observed, journal=saved)
                    break
            elif before["passed"] and before["core"] == core:
                stopped = all(before[key] not in processes for key in ("host", "bridge", "launcher"))
                cleared = all(not Path(before[key]).exists() for key in ("providerSocket", "flowSocket"))
                if stopped and cleared and not journal.exists():
                    result.update(core=core, stopped=True, privateSocketsRemoved=True, journalRemoved=True)
                    break
            time.sleep(.15)
        else:
            raise StepError(f"Signed SocksCap bridge did not reach {phase} with its expected process tree and journal")
        result["writerLease"] = writer_lease(profile / "plugins", slug="sockscap", enabled=phase == "pending")
        result["passed"] = True
        return f"Signed Redirector bridge {phase} verified"
    finally:
        (ctx.case_dir / f"redirector-{phase}.json").write_text(json.dumps(result, indent=2) + "\n")
