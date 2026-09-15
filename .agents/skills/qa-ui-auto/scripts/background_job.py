#!/usr/bin/env python3
"""Start long-lived commands detached from the calling shell and agent harness.

The interactive agent harness waits for a tool call's whole process tree to
exit, so a resident process (Vite dev server, native driver, a suite kept for
later polling) started in the foreground freezes the session until it dies.
`start` launches the command outside the caller's job object / session and
returns immediately with a state file; `status`, `wait` and `stop` operate on
that state.

Windows uses the WMI service (`Win32_Process.Create`) because plain children and
`Start-Process` stay inside the caller's job object. POSIX double-forks into a
new session with every standard handle redirected.

The wrapper appends `EXITCODE=<n>` to the log when the command ends; `wait`
propagates it (0-255) so suite failures stay visible.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

EXIT_MARKER = "EXITCODE="


def _configure_console_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def _state_path(log: Path, state: str | None) -> Path:
    if state:
        return Path(state).resolve()
    return log.with_name(log.name + ".job.json").resolve()


def _companion(state: Path, suffix: str) -> Path:
    return state.with_name(state.name + suffix)


def _parse_env(pairs: list[str] | None) -> dict[str, str]:
    env: dict[str, str] = {}
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"background_job: --env expects KEY=VALUE, got {item!r}")
        key, value = item.split("=", 1)
        env[key] = value
    return env


def _wrapper_env(inherit: bool, overrides: dict[str, str]) -> dict[str, str]:
    if inherit:
        env = dict(os.environ)
    else:
        env = {"PATH": os.environ.get("PATH", "")}
    env.update(overrides)
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


def _write_windows_wrapper(wrapper: Path, cwd: Path, env: dict[str, str],
                           command: list[str], log: Path) -> None:
    lines = ["@echo off", f'cd /d "{cwd}"']
    for key, value in env.items():
        lines.append(f'set "{key}={str(value).replace("%", "%%")}"')
    lines.append(f'call {subprocess.list2cmdline(command)} >>"{log}" 2>&1')
    # The space before `>>` is required: `%ERRORLEVEL%>>` expands to an empty
    # string in cmd (verified on Windows 10); the trailing space is stripped by
    # the exit-code parser.
    lines.append(f'echo {EXIT_MARKER}%ERRORLEVEL% >>"{log}"')
    wrapper.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8", newline="")


def _write_posix_wrapper(wrapper: Path, cwd: Path, command: list[str],
                         log: Path, pidfile: Path) -> None:
    rendered = " ".join(shlex.quote(part) for part in command)
    wrapper.write_text(
        "#!/bin/sh\n"
        f"cd {shlex.quote(str(cwd))} || exit 127\n"
        f"echo $$ > {shlex.quote(str(pidfile))}\n"
        f"{rendered} >> {shlex.quote(str(log))} 2>&1\n"
        f'echo "{EXIT_MARKER}$?" >> {shlex.quote(str(log))}\n',
        encoding="utf-8",
    )
    os.chmod(wrapper, 0o700)


def _start_windows(wrapper: Path, cwd: Path) -> int:
    script = (
        "$ErrorActionPreference='Stop';"
        "$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        "-Arguments @{CommandLine=$env:QA_BG_CMD; CurrentDirectory=$env:QA_BG_CWD};"
        "if ($p.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $p.ReturnValue) };"
        "$p.ProcessId"
    )
    command_line = "cmd.exe /d /s /c " + (
        f'""{wrapper}""' if " " in str(wrapper) else f'"{wrapper}"'
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True,
        env={**os.environ, "QA_BG_CMD": command_line, "QA_BG_CWD": str(cwd)},
    )
    if completed.returncode != 0:
        raise SystemExit(
            f"background_job: WMI launch failed ({completed.returncode}): "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
    lines = [line for line in completed.stdout.splitlines() if line.strip().isdigit()]
    if not lines:
        raise SystemExit(f"background_job: WMI launch returned no pid: {completed.stdout!r}")
    return int(lines[-1])


def _start_posix(wrapper: Path, env: dict[str, str], pidfile: Path) -> int:
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            if os.fork() > 0:
                os._exit(0)
            devnull = os.open(os.devnull, os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(devnull, 2)
            if devnull > 2:
                os.close(devnull)
            os.execve("/bin/sh", ["/bin/sh", str(wrapper)], env)
        except BaseException:
            os._exit(127)
    os.waitpid(pid, 0)
    deadline = time.time() + 5
    while time.time() < deadline:
        if pidfile.exists():
            return int(pidfile.read_text(encoding="utf-8").strip())
        time.sleep(0.05)
    raise SystemExit("background_job: detached wrapper did not report its pid")


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _read_exit_code(log: Path) -> int | None:
    try:
        tail = log.read_bytes()[-4096:].decode("utf-8", "replace")
    except OSError:
        return None
    for line in reversed(tail.splitlines()):
        line = line.strip()
        if line.startswith(EXIT_MARKER):
            try:
                return int(line[len(EXIT_MARKER):].strip())
            except ValueError:
                return None
    return None


def _load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"background_job: cannot read state {path}: {exc}") from exc


def _stop(pid: int, grace: float) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, text=True)
        deadline = time.time() + grace
        while time.time() < deadline and _pid_alive(pid):
            time.sleep(0.1)
        return
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        deadline = time.time() + grace
        while time.time() < deadline:
            if not _pid_alive(pid):
                return
            time.sleep(0.1)


def _tail(log: Path, count: int) -> list[str]:
    try:
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-count:]


def _cmd_start(args: argparse.Namespace) -> int:
    log = Path(args.log).resolve()
    log.parent.mkdir(parents=True, exist_ok=True)
    state = _state_path(log, args.state)
    state.parent.mkdir(parents=True, exist_ok=True)
    wrapper = _companion(state, ".cmd" if os.name == "nt" else ".sh")
    pidfile = _companion(state, ".pid")
    cwd = Path(args.cwd).resolve() if args.cwd else Path.cwd()
    if not cwd.is_dir():
        raise SystemExit(f"background_job: cwd does not exist: {cwd}")
    env = _wrapper_env(not args.no_env_inherit, _parse_env(args.env))
    if os.name == "nt":
        _write_windows_wrapper(wrapper, cwd, env, args.command, log)
        pid = _start_windows(wrapper, cwd)
    else:
        _write_posix_wrapper(wrapper, cwd, args.command, log, pidfile)
        pid = _start_posix(wrapper, env, pidfile)
    pidfile.write_text(str(pid), encoding="utf-8")
    state.write_text(json.dumps({
        "name": args.name,
        "pid": pid,
        "log": str(log),
        "wrapper": str(wrapper),
        "command": args.command,
        "cwd": str(cwd),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "platform": os.name,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"started name={args.name} pid={pid} log={log} state={state}")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    state = _load_state(Path(args.state).resolve())
    alive = _pid_alive(int(state["pid"]))
    code = _read_exit_code(Path(state["log"]))
    print(f"{'alive' if alive else 'dead'} name={state.get('name')} pid={state['pid']} "
          f"log={state['log']}"
          + (f" exit_code={code}" if code is not None else ""))
    for line in _tail(Path(state["log"]), args.tail):
        print(f"  | {line}")
    return 0


def _cmd_wait(args: argparse.Namespace) -> int:
    state = _load_state(Path(args.state).resolve())
    log = Path(state["log"])
    deadline = time.time() + args.timeout
    while _pid_alive(int(state["pid"])):
        if time.time() >= deadline:
            print(f"background_job: timed out after {args.timeout}s "
                  f"(pid {state['pid']} still alive; log={log})")
            return 2
        time.sleep(args.poll)
    code = _read_exit_code(log)
    if code is None:
        print(f"background_job: process ended without an exit marker (killed?); log={log}")
        return 1
    print(f"background_job: finished exit_code={code} log={log}")
    return code if 0 <= code <= 255 else 1


def _cmd_stop(args: argparse.Namespace) -> int:
    state = _load_state(Path(args.state).resolve())
    pid = int(state["pid"])
    if _pid_alive(pid):
        _stop(pid, args.grace)
    print(f"{'stopped' if not _pid_alive(pid) else 'still alive'} "
          f"name={state.get('name')} pid={pid}")
    return 0 if not _pid_alive(pid) else 1


def main(argv: list[str] | None = None) -> int:
    _configure_console_encoding()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)

    start = sub.add_parser("start", help="launch a detached command")
    start.add_argument("--name", required=True)
    start.add_argument("--log", required=True)
    start.add_argument("--state")
    start.add_argument("--cwd")
    start.add_argument("--env", action="append", metavar="KEY=VALUE")
    start.add_argument("--no-env-inherit", action="store_true")
    start.add_argument("command", nargs=argparse.REMAINDER)
    start.set_defaults(func=_cmd_start)

    status = sub.add_parser("status", help="report liveness and tail the log")
    status.add_argument("--state", required=True)
    status.add_argument("--tail", type=int, default=0)
    status.set_defaults(func=_cmd_status)

    wait = sub.add_parser("wait", help="block until the job ends and propagate its exit code")
    wait.add_argument("--state", required=True)
    wait.add_argument("--timeout", type=float, default=3600)
    wait.add_argument("--poll", type=float, default=2.0)
    wait.set_defaults(func=_cmd_wait)

    stop = sub.add_parser("stop", help="terminate the detached job tree")
    stop.add_argument("--state", required=True)
    stop.add_argument("--grace", type=float, default=10.0)
    stop.set_defaults(func=_cmd_stop)

    args = parser.parse_args(argv)
    command = getattr(args, "command", None)
    if command is not None:
        if command and command[0] == "--":
            command.pop(0)
        if not command:
            parser.error("start requires a command after --")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
