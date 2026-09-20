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
import subprocess
import tempfile
import time
import urllib.request
import zipfile

from qa_ui_auto.ci import write_json


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


def secret(name):
    value = "Qa1_" + secrets.token_hex(16)
    os.environ[name] = value
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{value}", flush=True)
    return value


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


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

    def docker(self, suffix, image, internal_port, environment):
        name = f"{self.namespace}-{suffix}"
        self.cleanup_command(["docker", "rm", "-f", name])
        argv = ["docker", "run", "-d", "--rm", "--name", name,
                "-p", f"127.0.0.1::{internal_port}"]
        for key, value in environment.items():
            argv += ["-e", f"{key}={value}"]
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
                 f"AllowUsers {user}", "StrictModes no", "LogLevel VERBOSE", "Subsystem sftp internal-sftp"]
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
            lines += ["UsePAM yes", f"PidFile {private / 'sshd.pid'}"]
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
                       "New-LocalUser -Name $env:QA_SERVICE_USER -Password $pw -PasswordNeverExpires | Out-Null")
            self.stack.callback(lambda: powershell("Remove-LocalUser -Name $env:QA_SERVICE_USER"))
            remote_dir = f"C:/qa-temp-{user}"
            powershell(f"New-Item -ItemType Directory -Force '{remote_dir}' | Out-Null; "
                       f"icacls '{remote_dir}' /grant '{user}:(OI)(CI)F' | Out-Null")
            self.stack.callback(lambda: shutil.rmtree(remote_dir, ignore_errors=True))
            # Git Bash supports the POSIX shell commands in the portable SSH cases.
            powershell("New-Item -Path HKLM:\\SOFTWARE\\OpenSSH -Force | Out-Null; "
                       "New-ItemProperty -Path HKLM:\\SOFTWARE\\OpenSSH -Name DefaultShell "
                       "-Value 'C:\\Program Files\\Git\\bin\\bash.exe' -PropertyType String -Force | Out-Null")
            cfg = private / "sshd_config"
            cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # sshd must run as LocalSystem for password logon/PTY impersonation.
            executable = Path(os.environ["WINDIR"]) / "System32/OpenSSH/sshd.exe"
            for protected in (host_key, cfg):
                command(["icacls", str(protected), "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"])
                command(["icacls", str(protected), "/setowner", "*S-1-5-32-544"])
            command([executable, "-t", "-f", cfg])
            standard = Path(os.environ["PROGRAMDATA"]) / "ssh/sshd_config"
            standard.parent.mkdir(parents=True, exist_ok=True)
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
                                         "Get-WinEvent -LogName OpenSSH/Operational -MaxEvents 10 -ErrorAction SilentlyContinue | Select-Object Message | ConvertTo-Json")
                (self.root / "service-diagnostics.json").write_text(diagnostics, encoding="utf-8")
                raise
        self.resources.append(f"sshd:{user}:{port}")
        return user, port, remote_dir

    def ssh(self):
        password = secret("QA_SSH_PASSWORD")
        if platform.system() == "Linux":
            user, remote_dir = "testuser", "/tmp/qa-ui-auto-temp"
            port = self.docker("sshd", "linuxserver/openssh-server:latest", 2222,
                               {"USER_NAME": user, "USER_PASSWORD": password, "PASSWORD_ACCESS": "true"})
        else:
            user, port, remote_dir = self.local_ssh(password)
        import paramiko
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        def probe():
            client.close()
            client.connect("127.0.0.1", port, user, password, timeout=5,
                           banner_timeout=5, auth_timeout=5, allow_agent=False, look_for_keys=False)
        retry(probe)
        self.stack.callback(client.close)
        nonce = secrets.token_hex(12)
        _, stdout, stderr = client.exec_command(f"echo {nonce}", get_pty=True, timeout=15)
        if nonce not in stdout.read().decode() or stdout.channel.recv_exit_status() != 0:
            raise RuntimeError("SSH authentication/PTY/exec probe failed")
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
            for name, payload in (("alpha.txt", b"one"), ("beta.txt", b"two-two"), ("gamma.txt", b"three-three")):
                with sftp.open(remote_dir + "/" + name, "wb") as stream:
                    stream.write(payload)
        finally:
            sftp.close()
        cfg = {"host": "127.0.0.1", "port": port, "user": user, "password": "${env.QA_SSH_PASSWORD}"}
        self.config.update(ssh=cfg.copy(), sftp={**cfg, "remote_test_dir": remote_dir})
        return {"authentication": True, "pty_exec": True, "sftp_roundtrip": True, "port": port}

    def mysql(self):
        import pymysql
        password = secret("TAOMNI_TEST_MYSQL_PASSWORD")
        root_password = secret("QA_MYSQL_ROOT_PASSWORD")
        if platform.system() == "Linux":
            port = self.docker("mysql", "mysql:8.4", 3306,
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

    def __enter__(self):
        if platform.system() != "Linux" and os.environ.get("GITHUB_ACTIONS") != "true":
            raise RuntimeError("native service account setup is restricted to hosted CI")
        self.root.mkdir(parents=True, exist_ok=True)
        self.private = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix=self.namespace)))
        try:
            facts = {"namespace": self.namespace, "platform": platform.system(), "resources": self.resources}
            if "ssh" in self.capabilities:
                facts["ssh"] = self.ssh()
            if "mysql" in self.capabilities:
                facts["mysql"] = self.mysql()
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
            print("SSH/SFTP/MySQL protocol probes passed")


if __name__ == "__main__":
    main()
