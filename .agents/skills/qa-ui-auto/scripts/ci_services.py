"""Job-owned hosted services. Credentials never enter config or artifact files."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
import yaml

from qa_ui_auto.ci import write_json

# Scriptable RFB server shared with the VNC skill: it logs every client message
# and takes control commands, so cases can prove what reached "the remote".
VNC_FIXTURE = Path(".agents/skills/vnc-realvnc-task/scripts/vnc_fixture_server.py")
VNC_FIXTURE_PACKAGES = ["numpy==2.4.4", "Pillow==12.1.1"]


def command(argv, **kwargs):
    # Deliberately do not log argv: account setup contains disposable passwords.
    result = subprocess.run([str(a) for a in argv], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(str(argv[0])).name} failed ({result.returncode}); {result.stderr[-2000:]}")
    return result.stdout.strip()


def powershell(script):
    return command(["pwsh.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "$ErrorActionPreference='Stop'; " + script])


def secret(name, value=None):
    value = value or "Qa1_" + secrets.token_hex(16)
    os.environ[name] = value
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{value}", flush=True)
    return value


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def jump_target_endpoint(system: str, mapped_port: int) -> tuple[str, int]:
    return "127.0.0.1", 2222 if system == "Linux" else mapped_port


def sshd_forwarding_policy(private: Path) -> tuple[Path, str]:
    config = private / "sshd_config.d" / "qa-forwarding.conf"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text("AllowTcpForwarding yes\nPermitOpen any\n", encoding="utf-8")
    return config, "/config/sshd/sshd_config.d/qa-forwarding.conf:ro"


def rfb_probe(port, password):
    """Authenticate to the VNC fixture with VNCAuth and read its ServerInit."""
    sys.path.insert(0, str(VNC_FIXTURE.parent.resolve()))
    try:
        from vnc_des import vnc_auth_response
    finally:
        sys.path.pop(0)

    def exact(sock, size):
        data = b""
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError("VNC fixture closed the probe connection")
            data += chunk
        return data

    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.settimeout(5)
        if not exact(sock, 12).startswith(b"RFB 003."):
            raise RuntimeError("VNC fixture did not announce RFB")
        sock.sendall(b"RFB 003.008\n")
        offered = exact(sock, exact(sock, 1)[0])
        if 2 not in offered:
            raise RuntimeError(f"VNC fixture does not offer VNCAuth: {list(offered)}")
        sock.sendall(b"\x02")
        sock.sendall(vnc_auth_response(password, exact(sock, 16)))
        if struct.unpack(">I", exact(sock, 4))[0] != 0:
            raise RuntimeError("VNC fixture rejected the probe password")
        sock.sendall(b"\x01")
        width, height = struct.unpack(">HH", exact(sock, 4))
        exact(sock, 16)
        name = exact(sock, struct.unpack(">I", exact(sock, 4))[0]).decode()
    return width, height, name


def vnc_control(port, *commands):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(("\n".join(commands) + "\n").encode())
        sock.shutdown(socket.SHUT_WR)
        sock.settimeout(5)
        reply = b""
        # The fixture answers every line, then closes the connection.
        while chunk := sock.recv(65536):
            reply += chunk
    return reply.decode().splitlines()


def retry(probe, seconds=120):
    end = time.monotonic() + seconds
    while True:
        try:
            return probe()
        except Exception as exc:
            if time.monotonic() >= end:
                raise RuntimeError(f"service protocol readiness timed out: {type(exc).__name__}: {exc}") from exc
            time.sleep(1)


def install(capabilities):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("package/account installation is restricted to GitHub hosted jobs")
    if "vnc" in capabilities:
        command([sys.executable, "-m", "pip", "install", *VNC_FIXTURE_PACKAGES])
    system = platform.system()
    if system == "Linux":
        command(["docker", "info", "--format", "{{.ServerVersion}}"])
    elif system == "Darwin":
        packages = (["mysql@8.4"] if "mysql" in capabilities else []) + (["openssh"] if "ssh" in capabilities else [])
        if packages:
            command(["brew", "install", *packages])
    elif system == "Windows":
        if "ssh" in capabilities:
            powershell("if (-not (Test-Path $env:WINDIR\\System32\\OpenSSH\\sshd.exe)) { "
                       "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }")
        if "mysql" in capabilities:
            root = Path(os.environ["RUNNER_TEMP"]) / "qa-mysql-package"
            root.mkdir(exist_ok=True)
            archive = root / "mysql.zip"
            urllib.request.urlretrieve("https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.4-winx64.zip", archive)
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(root)
            archive.unlink()
            with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
                stream.write(f"QA_MYSQL_BIN={next(root.glob('mysql-*/bin')).as_posix()}\n")


class Services:
    def __init__(self, root, capabilities, config):
        self.root = Path(root).resolve()
        self.capabilities = set(capabilities)
        self.config = config
        self.stack = ExitStack()
        self.namespace = "qa" + secrets.token_hex(5)
        self.resources = []
        self.images = yaml.safe_load(Path("qa-ui-auto-tests/ci/services.yaml").read_text(encoding="utf-8"))

    def cleanup_command(self, argv):
        def cleanup():
            try:
                command(argv)
            except Exception as exc:
                print(f"service cleanup: {type(exc).__name__}", flush=True)
        self.stack.callback(cleanup)

    def start_process(self, argv, name):
        log = self.stack.enter_context((self.root / f"{name}.log").open("w", encoding="utf-8"))
        process = subprocess.Popen([str(a) for a in argv], stdout=log, stderr=subprocess.STDOUT)
        def stop():
            if process.poll() is None:
                if platform.system() == "Windows":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self.stack.callback(stop)
        return process

    def docker(self, suffix, image, internal_port, environment, volumes=()):
        name = f"{self.namespace}-{suffix}"
        self.cleanup_command(["docker", "rm", "-f", name])
        argv = ["docker", "run", "-d", "--rm", "--name", name,
                "-p", f"127.0.0.1::{internal_port}"]
        for key, value in environment.items():
            argv += ["-e", f"{key}={value}"]
        for source, target in volumes:
            argv += ["-v", f"{source}:{target}"]
        command([*argv, image])
        self.resources.append(name)
        return int(command(["docker", "port", name, str(internal_port)]).splitlines()[0].rsplit(":", 1)[1])

    def local_ssh(self, password):
        system = platform.system()
        user, port = self.namespace, free_port()
        private = self.private
        host_key = private / "host_key"
        ssh_keygen = "ssh-keygen"
        if system == "Windows":
            ssh_keygen = str(Path(os.environ["WINDIR"]) / "System32/OpenSSH/ssh-keygen.exe")
        command([ssh_keygen, "-t", "ed25519", "-N", "", "-f", str(host_key)])
        lines = [f"Port {port}", "ListenAddress 127.0.0.1", f'HostKey "{host_key.as_posix()}"',
                 "PasswordAuthentication yes", "PubkeyAuthentication no", "PermitEmptyPasswords no",
                 f"AllowUsers {user}", "StrictModes no", "LogLevel DEBUG3", "Subsystem sftp internal-sftp"]
        if system == "Darwin":
            uid = str(5500 + secrets.randbelow(2000))
            remote_dir = f"/private/tmp/{self.namespace}-temp"
            home = f"/Users/{user}"
            self.cleanup_command(["sudo", "-n", "dscl", ".", "-delete", f"/Users/{user}"])
            for key, value in (("UserShell", "/bin/bash"), ("UniqueID", uid), ("PrimaryGroupID", "20"),
                               ("NFSHomeDirectory", home), ("RealName", "Disposable QA account")):
                command(["sudo", "-n", "dscl", ".", "-create", f"/Users/{user}", key, value])
            command(["sudo", "-n", "dscl", ".", "-passwd", f"/Users/{user}", password])
            command(["sudo", "-n", "mkdir", "-p", home, remote_dir])
            command(["sudo", "-n", "chown", "-R", f"{user}:staff", home, remote_dir])
            # The temporary account is owned by this VM/job, not a shared user.
            self.cleanup_command(["sudo", "-n", "rm", "-r", home, remote_dir])
            # Avoid PAM's keyboard-interactive fallback on a rejected password.
            lines += ["UsePAM yes", "KbdInteractiveAuthentication no", f"PidFile {private / 'sshd.pid'}"]
            # Add only the disposable account when macOS restricts SSH login.
            group = subprocess.run(["dscl", ".", "-read", "/Groups/com.apple.access_ssh"], capture_output=True)
            if group.returncode == 0:
                command(["sudo", "-n", "dseditgroup", "-o", "edit", "-a", user, "-t", "user", "com.apple.access_ssh"])
            cfg = private / "sshd_config"
            cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
            sshd = Path(command(["brew", "--prefix", "openssh"])) / "sbin/sshd"
            self.start_process(["sudo", "-n", sshd, "-D", "-e", "-f", cfg], "sshd")
        else:
            os.environ["QA_SERVICE_USER"] = user
            # Password supplied through the child environment, never a log or artifact.
            powershell("$pw=ConvertTo-SecureString $env:QA_SSH_PASSWORD -AsPlainText -Force; "
                       "New-LocalUser -Name $env:QA_SERVICE_USER -Password $pw -PasswordNeverExpires | Out-Null; "
                       "$cred=[PSCredential]::new($env:QA_SERVICE_USER,$pw); "
                       "Start-Process $env:WINDIR\\System32\\cmd.exe -Credential $cred -LoadUserProfile "
                       "-ArgumentList '/c exit 0' -Wait")
            self.stack.callback(lambda: powershell("Remove-LocalUser -Name $env:QA_SERVICE_USER"))
            remote_dir = f"C:/qa-temp-{user}"
            powershell(f"New-Item -ItemType Directory -Force '{remote_dir}' | Out-Null; "
                       f"icacls '{remote_dir}' /grant '{user}:(OI)(CI)F' | Out-Null")
            self.stack.callback(lambda: shutil.rmtree(remote_dir, ignore_errors=True))
            # Git Bash supports the POSIX shell commands in the portable SSH cases.
            powershell("New-Item -Path HKLM:\\SOFTWARE\\OpenSSH -Force | Out-Null; "
                       "New-ItemProperty -Path HKLM:\\SOFTWARE\\OpenSSH -Name DefaultShell "
                       "-Value 'C:\\Program Files\\Git\\bin\\bash.exe' -PropertyType String -Force | Out-Null; "
                       "New-ItemProperty -Path HKLM:\\SOFTWARE\\OpenSSH -Name DefaultShellCommandOption "
                       "-Value '-c' -PropertyType String -Force | Out-Null")
            cfg = private / "sshd_config"
            cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # sshd must run as LocalSystem for password logon/PTY impersonation.
            executable = Path(os.environ["WINDIR"]) / "System32/OpenSSH/sshd.exe"
            # The service runs as SYSTEM; use the standard machine host-key
            # location instead of a runner user's temporary directory.
            command([ssh_keygen, "-A"])
            lines = [line for line in lines if not line.startswith("HostKey ")]
            cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
            for protected in (cfg,):
                command(["icacls", str(protected), "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"])
                command(["icacls", str(protected), "/setowner", "*S-1-5-32-544"])
            command([executable, "-t", "-f", cfg])
            standard = Path(os.environ["PROGRAMDATA"]) / "ssh/sshd_config"
            standard.parent.mkdir(parents=True, exist_ok=True)
            (standard.parent / "logs").mkdir(exist_ok=True)
            previous = standard.read_bytes() if standard.exists() else None
            self.stack.callback(lambda: standard.write_bytes(previous) if previous is not None else standard.unlink(missing_ok=True))
            standard.write_text("\n".join(lines + ["SyslogFacility LOCAL0"]) + "\n", encoding="utf-8")
            command(["icacls", str(standard), "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"])
            command(["icacls", str(standard), "/setowner", "*S-1-5-32-544"])
            os.environ["QA_SSH_SERVICE_COMMAND"] = f'"{executable}"'
            powershell("Stop-Service sshd -ErrorAction SilentlyContinue; "
                       "if (Get-Service sshd -ErrorAction SilentlyContinue) { "
                       "sc.exe config sshd binPath= $env:QA_SSH_SERVICE_COMMAND | Out-Null } else { "
                       "New-Service -Name sshd -BinaryPathName $env:QA_SSH_SERVICE_COMMAND -StartupType Manual | Out-Null }")
            def collect_windows_logs():
                log = standard.parent / "logs/sshd.log"
                if log.is_file():
                    shutil.copy2(log, self.root / "sshd.log")
            self.stack.callback(collect_windows_logs)
            self.stack.callback(lambda: powershell("Stop-Service sshd -ErrorAction SilentlyContinue"))
            try:
                powershell("Start-Service sshd")
            except Exception:
                diagnostics = powershell("Get-CimInstance Win32_Service -Filter \"Name='sshd'\" | Select-Object Name,PathName,StartName,ExitCode | ConvertTo-Json; "
                                         "Get-WinEvent -LogName OpenSSH/Admin,OpenSSH/Operational -MaxEvents 20 -ErrorAction SilentlyContinue | Select-Object TimeCreated,Message | ConvertTo-Json")
                (self.root / "service-diagnostics.json").write_text(diagnostics, encoding="utf-8")
                raise
        self.resources.append(f"sshd:{user}:{port}")
        return user, port, remote_dir

    def ssh(self):
        password = secret("QA_SSH_PASSWORD")
        system = platform.system()
        if system == "Linux":
            user, remote_dir = "testuser", "/tmp/qa-ui-auto-temp"
            forwarding_config = sshd_forwarding_policy(self.private)
            port = self.docker("sshd", self.images["ssh_image"], 2222,
                               {"USER_NAME": user, "USER_PASSWORD": password, "PASSWORD_ACCESS": "true"},
                               volumes=[forwarding_config])
        else:
            user, port, remote_dir = self.local_ssh(password)
        import paramiko
        import pyte
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        def probe():
            client.close()
            client.connect("127.0.0.1", port, user, password, timeout=5,
                           banner_timeout=5, auth_timeout=5, allow_agent=False, look_for_keys=False)
        retry(probe)
        self.stack.callback(client.close)
        nonce = secrets.token_hex(12)
        _, stdout, stderr = client.exec_command(f"echo {nonce}", timeout=60)
        output = stdout.read().decode(errors="replace")
        error = stderr.read().decode(errors="replace")
        code = stdout.channel.recv_exit_status()
        write_json(self.root / "ssh-exec.json", {"output": output, "stderr": error, "exit": code})
        if nonce not in output or code != 0:
            raise RuntimeError("SSH exec probe failed; see ssh-exec.json")
        channel = client.invoke_shell(width=120, height=32)
        output = ""
        screen = pyte.Screen(120, 32)
        terminal = pyte.Stream(screen)
        try:
            channel.settimeout(2)
            # Shell output must contain a fresh nonce on its own line, not
            # merely the command echo. No exit-status assumption for ConPTY.
            marker = secrets.token_hex(12)
            channel.send(f"printf '\\n%s\\n' '{marker}'\r")
            end = time.monotonic() + 30
            while time.monotonic() < end:
                try:
                    data = channel.recv(4096)
                except socket.timeout:
                    continue
                if not data:
                    break
                output += data.decode(errors="replace")
                terminal.feed(data.decode(errors="replace"))
                # Windows ConPTY paints using ANSI escapes, and asks the
                # terminal to report its cursor before starting the shell.
                if b"\x1b[6n" in data:
                    channel.send("\x1b[1;1R")
                if marker in [line.strip() for line in screen.display]:
                    break
            else:
                raise RuntimeError("SSH PTY shell did not produce the nonce; see ssh-pty.json")
            if marker not in [line.strip() for line in screen.display]:
                raise RuntimeError("SSH PTY closed without command output; see ssh-pty.json")
        finally:
            write_json(self.root / "ssh-pty.json", {"output": output, "screen": screen.display})
            channel.close()
        sftp = client.open_sftp()
        try:
            try:
                sftp.mkdir(remote_dir)
            except OSError:
                sftp.stat(remote_dir)
            probe_path = remote_dir + "/probe.txt"
            with sftp.open(probe_path, "wb") as stream:
                stream.write(nonce.encode())
            with sftp.open(probe_path, "rb") as stream:
                if stream.read() != nonce.encode():
                    raise RuntimeError("SFTP byte roundtrip differs")
            sftp.remove(probe_path)
            # TC-010 mutates files in its own initially empty directory.
            # Without it navigation fails and the case stays in the SSH home.
            sftp.mkdir(remote_dir + "/tc010")
            for name, payload in (("alpha.txt", b"one"), ("beta.txt", b"two-two"), ("gamma.txt", b"three-three")):
                with sftp.open(remote_dir + "/" + name, "wb") as stream:
                    stream.write(payload)
        finally:
            sftp.close()
        cfg = {"host": "127.0.0.1", "port": port, "user": user, "password": "${env.QA_SSH_PASSWORD}"}
        shell_dir = "/c/" + remote_dir[3:] if system == "Windows" else remote_dir
        sftp_shell_dir = "/" + remote_dir if system == "Windows" else remote_dir
        jump_target_host, jump_target_port = jump_target_endpoint(system, port)
        cfg.update(jump_target_host=jump_target_host, jump_target_port=jump_target_port)
        self.config.update(ssh=cfg.copy(), sftp={**cfg, "remote_test_dir": remote_dir,
                                             "remote_shell_test_dir": shell_dir,
                                             "remote_sftp_shell_test_dir": sftp_shell_dir,
                                             "chmod_readback_mode": "644" if system == "Windows" else "600"})
        return {"authentication": True, "pty_exec": True, "sftp_roundtrip": True, "port": port}

    def mysql(self):
        import pymysql
        password = secret("TAOMNI_TEST_MYSQL_PASSWORD")
        root_password = secret("QA_MYSQL_ROOT_PASSWORD")
        if platform.system() == "Linux":
            port = self.docker("mysql", self.images["mysql_image"], 3306,
                               {"MYSQL_ROOT_PASSWORD": root_password, "MYSQL_DATABASE": "test",
                                "MYSQL_USER": "test", "MYSQL_PASSWORD": password})
        else:
            port = free_port()
            binary_dir = (Path(command(["brew", "--prefix", "mysql@8.4"])) / "bin"
                          if platform.system() == "Darwin" else Path(os.environ["QA_MYSQL_BIN"]))
            daemon = binary_dir / ("mysqld.exe" if platform.system() == "Windows" else "mysqld")
            data = self.private / "mysql-data"
            common = [daemon, "--no-defaults", f"--basedir={binary_dir.parent}", f"--datadir={data}"]
            command([*common, "--initialize-insecure"])
            self.start_process([*common, "--bind-address=127.0.0.1", f"--port={port}",
                                f"--socket={self.private / 'mysql.sock'}", "--mysqlx=0"], "mysql")
            def seed():
                return pymysql.connect(host="127.0.0.1", port=port, user="root", connect_timeout=3)
            connection = retry(seed)
            with connection:
                with connection.cursor() as cursor:
                    cursor.execute("CREATE DATABASE test")
                    cursor.execute("CREATE USER 'test'@'127.0.0.1' IDENTIFIED BY %s", (password,))
                    cursor.execute("CREATE USER 'test'@'localhost' IDENTIFIED BY %s", (password,))
                    cursor.execute("GRANT ALL ON test.* TO 'test'@'127.0.0.1'")
                    cursor.execute("GRANT ALL ON test.* TO 'test'@'localhost'")
                    cursor.execute("ALTER USER 'root'@'localhost' IDENTIFIED BY %s", (root_password,))
        def connect():
            return pymysql.connect(host="127.0.0.1", port=port, user="test", password=password,
                                   database="test", connect_timeout=3, autocommit=True)
        connection = retry(connect)
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("CREATE TABLE qa_probe (id INT PRIMARY KEY, value VARCHAR(100))")
                cursor.execute("INSERT INTO qa_probe VALUES (1, 'ready')")
                cursor.execute("SELECT value FROM qa_probe WHERE id=1")
                if cursor.fetchone() != ("ready",):
                    raise RuntimeError("MySQL DML roundtrip differs")
                cursor.execute("UPDATE qa_probe SET value='updated' WHERE id=1")
                cursor.execute("DELETE FROM qa_probe WHERE id=1")
        cfg = {"host": "127.0.0.1", "port": port, "user": "test", "database": "test",
               "password": "${env.TAOMNI_TEST_MYSQL_PASSWORD}"}
        self.config.update(database=cfg.copy(), mysql=cfg.copy())
        return {"authentication": True, "dml_roundtrip": True, "port": port}

    def vnc(self):
        # VNCAuth keys only the first 8 password bytes.
        password = secret("QA_VNC_PASSWORD", "Qv" + secrets.token_urlsafe(6)[:6])
        port, control_port = free_port(), free_port()
        events = self.root / "vnc-events.jsonl"
        process = self.start_process([sys.executable, VNC_FIXTURE.resolve(), "--port", port,
                                      "--control-port", control_port, "--log", events,
                                      "--security", "vncauth", "--password-env", "QA_VNC_PASSWORD",
                                      "--ext-clipboard", "--clip-formats", "text,html"], "vnc-fixture")
        def probe():
            if process.poll() is not None:
                raise RuntimeError(f"VNC fixture exited ({process.returncode}); see vnc-fixture.log")
            return rfb_probe(port, password)
        width, height, name = retry(probe, 60)
        reply = vnc_control(control_port, "stats")
        if len(reply) != 1 or not isinstance(json.loads(reply[0]), list):
            raise RuntimeError("VNC fixture control port did not answer")
        self.resources.append(f"vnc-fixture:{port}")
        self.config["vnc"] = {"host": "127.0.0.1", "port": port, "password": "${env.QA_VNC_PASSWORD}",
                              "control_port": control_port}
        return {"authentication": True, "server_init": [width, height, name], "port": port,
                "control_port": control_port}

    def __enter__(self):
        accounts = self.capabilities & {"ssh", "mysql"}
        if accounts and platform.system() != "Linux" and os.environ.get("GITHUB_ACTIONS") != "true":
            raise RuntimeError("native service account setup is restricted to hosted CI")
        self.root.mkdir(parents=True, exist_ok=True)
        self.private = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix=self.namespace)))
        try:
            facts = {"namespace": self.namespace, "platform": platform.system(), "resources": self.resources,
                     "images": self.images if platform.system() == "Linux" else None}
            if "ssh" in self.capabilities:
                facts["ssh"] = self.ssh()
            if "mysql" in self.capabilities:
                facts["mysql"] = self.mysql()
            if "vnc" in self.capabilities:
                facts["vnc"] = self.vnc()
            write_json(self.root / "lease.json", facts)
            return self
        except BaseException:
            self.stack.close()
            raise

    def __exit__(self, *exc):
        self.stack.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["install", "probe"])
    args = parser.parse_args()
    caps = json.loads(os.environ.get("QA_CAPABILITIES", '["ssh", "mysql"]'))
    if args.command == "install":
        install(caps)
    else:
        with Services(Path("qa-ui-auto-report/service-probe"), caps, {}):
            print(f"service protocol probes passed: {', '.join(sorted(caps))}")


if __name__ == "__main__":
    main()
