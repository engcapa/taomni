"""Isolate Windows SSH/ConPTY input from the app; never retries a command."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import socket
import time

import paramiko
import pyte

from ci_services import Services


def open_shell(client, shell):
    return client.invoke_shell(term="xterm-256color", width=171, height=32)


class TerminalProbe:
    def __init__(self, channel):
        self.channel = channel
        self.screen = pyte.Screen(171, 32)
        self.stream = pyte.Stream(self.screen)
        self.started = time.monotonic()
        self.frames = []
        self.dsr_tail = b""

    def record(self, direction, data):
        self.frames.append({"elapsed_ms": (time.monotonic() - self.started) * 1000,
                            "direction": direction,
                            "data_base64": base64.b64encode(data).decode("ascii")})

    def send(self, data):
        self.record("sent", data)
        self.channel.sendall(data)

    def wait(self, condition, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data = self.channel.recv(65536)
            except socket.timeout:
                continue
            if not data:
                return False
            self.record("received", data)
            self.stream.feed(data.decode("utf-8", errors="replace"))
            combined = self.dsr_tail + data
            # ConPTY asks for the initial cursor. Respond with the observed
            # cursor, just as a terminal does; recognize split query frames.
            for _ in range(combined.count(b"\x1b[6n")):
                self.send(f"\x1b[{self.screen.cursor.y + 1};{self.screen.cursor.x + 1}R".encode())
            self.dsr_tail = combined[-3:]
            if condition(self.screen.display):
                return True
        return False

    def run(self, marker, *, resize, focus, delay, protocol="vt", shell="console"):
        self.channel.settimeout(0.1)
        ready = self.wait(lambda lines: any(line.rstrip().endswith("$") for line in lines), 30)
        if ready and shell == "msys-script":
            # Initialize the POSIX PTY through the real interactive shell.
            # Win32 sshd's exec command line can lose the command-string
            # quoting for Bash -c ("-c exec ..." exits without running script).
            # Bootstrap happens before resize/focus and is never replayed.
            self.send(b'exec /usr/bin/script -q -c "env PS1=\'qa-posix-pty$ \' /usr/bin/bash --noprofile --norc -i" /dev/null\r')
            ready = self.wait(lambda lines: any(line.strip() == "qa-posix-pty$" for line in lines), 30)
        if not ready:
            return {"ready": False, "passed": False, "frames": self.frames, "screen": self.screen.display}
        if focus:
            self.send(b"\x1b[O")
        if resize:
            self.channel.resize_pty(width=104, height=32)
            self.screen.resize(lines=32, columns=104)
            self.frames.append({"elapsed_ms": (time.monotonic() - self.started) * 1000,
                                "direction": "resize", "cols": 104, "rows": 32})
        if focus:
            self.send(b"\x1b[I")
        if delay:
            time.sleep(delay)
        # Exactly one echo and one Enter. A failed input stays failed.
        if protocol == "win32":
            for character in f"echo {marker}\r":
                for down in (1, 0):
                    self.send(f"\x1b[0;0;{ord(character)};{down};0;1_".encode())
        elif protocol == "paste":
            self.send(f"\x1b[200~echo {marker}\x1b[201~".encode())
            self.send(b"\r")
        else:
            self.send(f"echo {marker}".encode())
            self.send(b"\r")
        passed = self.wait(lambda lines: marker in [line.strip() for line in lines], 5)
        return {"ready": True, "passed": passed, "frames": self.frames, "screen": self.screen.display}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--delays", default="0,0.01,0.05,0.1,0.25,0.5")
    parser.add_argument("--protocol", choices=["vt", "win32", "paste"], default="vt")
    parser.add_argument("--shell", choices=["console", "msys-script", "msys-console"], default="console")
    parser.add_argument("--shell-executable", type=Path)
    parser.add_argument("--sshd-executable", type=Path)
    parser.add_argument("--server-runtime", choices=["win32", "cygwin"], default="win32")
    args = parser.parse_args()
    delays = [float(value) for value in args.delays.split(",")]
    if not delays or any(value < 0 or value > 2 for value in delays):
        parser.error("delays must be between 0 and 2 seconds")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "probe-identity.json").write_text(json.dumps({
        "sha": os.environ.get("GITHUB_SHA"), "server_runtime": args.server_runtime,
        "shell": args.shell, "protocol": args.protocol,
        "observation": "Diagnostic only; a setup failure has no protocol or app coverage",
    }, indent=2) + "\n", encoding="utf-8")
    config = {}
    results = []
    server_version = None
    shell = args.shell_executable or (Path("C:/msys64/usr/bin/bash.exe") if args.shell.startswith("msys-") else None)
    with Services(args.out / "services", {"ssh"}, config, ssh_windows_shell=shell,
                  ssh_windows_sshd=args.sshd_executable, ssh_windows_runtime=args.server_runtime):
        connection = config["ssh"]
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(connection["host"], connection["port"], connection["user"],
                           os.environ["QA_SSH_PASSWORD"], allow_agent=False, look_for_keys=False)
            server_version = client.get_transport().remote_version
            _, facts, errors = client.exec_command("printf 'BASH_VERSION=%s\\n' \"$BASH_VERSION\"; /usr/bin/uname -a; git --version; command -v script; command -v winpty")
            (args.out / "shell-versions.txt").write_text(
                facts.read().decode(errors="replace") + errors.read().decode(errors="replace"), encoding="utf-8")
            for delay in delays:
                for resize, focus in ((False, False), (False, True), (True, False), (True, True)):
                    channel = open_shell(client, args.shell)
                    try:
                        result = TerminalProbe(channel).run(
                            f"qa-ssh-protocol-{len(results) + 1}", resize=resize, focus=focus, delay=delay,
                            protocol=args.protocol, shell=args.shell)
                        result.update(resize=resize, focus=focus, delay=delay, protocol=args.protocol, shell=args.shell)
                        result.update(channel_closed=channel.closed,
                                      exit_status=channel.recv_exit_status() if channel.exit_status_ready() else None)
                        results.append(result)
                        print(json.dumps({k: v for k, v in result.items() if k not in {"frames", "screen"}}), flush=True)
                    finally:
                        channel.close()
        finally:
            client.close()
            (args.out / "input-probe.json").write_text(json.dumps({
                "observation": "Direct SSH protocol diagnostic; no app/browser/native case coverage",
                "sha": os.environ.get("GITHUB_SHA"), "results": results,
                "server_version": server_version, "server_runtime": args.server_runtime,
            }, indent=2) + "\n", encoding="utf-8")
    if len(results) != len(delays) * 4 or not all(result["passed"] for result in results):
        raise SystemExit("SSH input probe failed; original frames retained")


if __name__ == "__main__":
    main()
