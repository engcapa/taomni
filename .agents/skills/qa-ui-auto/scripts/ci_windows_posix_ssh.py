"""Diagnostic Windows SSH service with a real POSIX PTY, without ConPTY.

Only the disposable GitHub VM/account/installation are changed. Normal hosted
services keep using Win32 OpenSSH until the diagnostic proves this alternative.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil


def start(services, password):
    from ci_services import command, free_port, powershell

    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("POSIX SSH account setup is restricted to GitHub hosted jobs")
    root = Path(os.environ["QA_CYGWIN_ROOT"]).resolve()
    binary = root / "bin"
    sshd = root / "usr/sbin/sshd.exe"
    if not sshd.is_file():
        raise RuntimeError("The diagnostic requires the owned Cygwin OpenSSH installation")
    user, port = services.namespace, free_port()
    private = services.private / "posix-ssh"
    private.mkdir()

    def path(value):
        return command([binary / "cygpath.exe", "-u", str(value)])

    # Start sshd as the same temporary account that authenticates to it. This
    # keeps the POSIX process unprivileged and avoids changing runner credentials.
    os.environ["QA_POSIX_SSH_USER"] = user
    powershell("$pw=ConvertTo-SecureString $env:QA_SSH_PASSWORD -AsPlainText -Force; "
               "New-LocalUser -Name $env:QA_POSIX_SSH_USER -Password $pw -PasswordNeverExpires | Out-Null; "
               "$cred=[PSCredential]::new($env:QA_POSIX_SSH_USER,$pw); "
               "Start-Process $env:WINDIR\\System32\\cmd.exe -Credential $cred -LoadUserProfile "
               "-ArgumentList '/c exit 0' -Wait")
    services.cleanup_action("posix-ssh-user", lambda: powershell(
        "Remove-LocalUser -Name $env:QA_POSIX_SSH_USER"))
    records = command([binary / "mkpasswd.exe", "-l", "-u", user])
    fields = next((line.split(":") for line in records.splitlines()
                   if line.split(":")[0].casefold() == user.casefold()), None)
    if fields is None or len(fields) != 7:
        raise RuntimeError("Cannot resolve the disposable POSIX SSH account")
    fields[5:7] = [f"/home/{user}", "/bin/bash"]
    passwd = root / "etc/passwd"
    previous = passwd.read_bytes() if passwd.exists() else None
    services.cleanup_action("posix-ssh-passwd", lambda: (
        passwd.write_bytes(previous) if previous is not None else passwd.unlink(missing_ok=True)))
    with passwd.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write("\n" + ":".join(fields) + "\n")
    home = root / "home" / user
    home.mkdir(parents=True)
    services.cleanup_action("posix-ssh-home", lambda: shutil.rmtree(home, ignore_errors=True))
    for directory in (services.private, private, home):
        command(["icacls", str(directory), "/grant", f"{user}:(OI)(CI)F"])
    key = private / "host_key"
    command([binary / "ssh-keygen.exe", "-t", "ed25519", "-N", "", "-f", path(key)])
    command([binary / "chown.exe", user, path(key)])
    command([binary / "chmod.exe", "0600", path(key)])
    config = private / "sshd_config"
    config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {path(key)}
PidFile {path(private / 'sshd.pid')}
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication no
PermitEmptyPasswords no
StrictModes no
AllowUsers {user}
AllowTcpForwarding yes
SetEnv "PATH=/usr/bin:/bin"
Subsystem sftp internal-sftp
LogLevel DEBUG3
""", encoding="utf-8", newline="\n")
    command([sshd, "-t", "-f", path(config)])
    os.environ.update(QA_POSIX_SSH_BIN=str(sshd), QA_POSIX_SSH_CONFIG=path(config),
                      QA_POSIX_SSH_LOG=str(services.root / "posix-sshd.log"),
                      QA_POSIX_SSH_DLL_PATH=str(binary))
    result = powershell(
        "$pw=ConvertTo-SecureString $env:QA_SSH_PASSWORD -AsPlainText -Force; "
        "$cred=[PSCredential]::new($env:QA_POSIX_SSH_USER,$pw); "
        "$env:PATH=$env:QA_POSIX_SSH_DLL_PATH+';'+$env:PATH; "
        "$p=Start-Process -FilePath $env:QA_POSIX_SSH_BIN -Credential $cred -LoadUserProfile "
        "-ArgumentList @('-D','-e','-f',$env:QA_POSIX_SSH_CONFIG) "
        "-RedirectStandardError $env:QA_POSIX_SSH_LOG -PassThru; $p.Id")
    pid = int(result.strip())
    services.cleanup_action("posix-sshd-stop", lambda: command(
        ["taskkill", "/PID", str(pid), "/T", "/F"]))
    services.resources.append(f"cygwin-sshd:{user}:{port}")
    return user, port, f"/home/{user}/qa-temp"
