"""Owned real SSH/Kerberos services for protocol and desktop integration cases.

No public services or shared tickets. Linux/macOS use native MIT KDCs; Windows
uses an isolated Cygwin installation with GSSAPI-enabled OpenSSH (the inbox
Microsoft client does not implement GSSAPI). Every selected job proves a ticket
exchange and an authenticated SSH command before starting the application.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.request


def install():
    from ci_services import command
    system = platform.system()
    if system == "Linux":
        command(["sudo", "-n", "apt-get", "update"])
        command(["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y",
                 "krb5-kdc", "krb5-admin-server", "krb5-user", "openssh-server", "python3", "xauth", "x11-apps"])
    elif system == "Darwin":
        command(["brew", "install", "krb5"])
    else:
        root = Path(os.environ["RUNNER_TEMP"]) / "qa-cygwin"
        setup = root.parent / "qa-cygwin-setup.exe"
        # The official installer verifies the signed repository metadata and
        # each package checksum. Use HTTPS and keep its setup logs as evidence.
        urllib.request.urlretrieve("https://cygwin.com/setup-x86_64.exe", setup)
        if hashlib.sha256(setup.read_bytes()).hexdigest() != "2c9f2fb56e1fb687b5d9680afa8f8b06e6214f0e483096af0eae1946431226c5":
            raise RuntimeError("Cygwin installer checksum differs from pinned version")
        result = subprocess.run([str(setup), "--quiet-mode", "--no-shortcuts", "--no-startmenu", "--no-desktop",
            "--root", str(root), "--local-package-dir", str(root.parent / "qa-cygwin-packages"),
            "--site", "https://mirrors.kernel.org/sourceware/cygwin/", "--packages",
            "openssh,krb5-server,krb5-workstation,python3,coreutils"], timeout=900)
        if result.returncode: raise RuntimeError("Cygwin SSH/Kerberos package installation failed")
        os.environ["QA_CYGWIN_ROOT"] = root.as_posix()
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
            stream.write(f"QA_CYGWIN_ROOT={root.as_posix()}\n")


def start(services):
    from ci_services import command, free_port, retry, secret
    system = platform.system()
    private = services.private / "ssh-features"
    private.mkdir()
    port, kdc_port = free_port(), free_port()
    realm = "TAOMNI.QA"
    # Ubuntu OpenSSH canonicalizes localhost through the runner's cloud DNS
    # even with libkrb5 canonicalization disabled. Authorize that real host
    # principal in this disposable realm, never a cross-realm cloud ticket.
    hostnames = sorted({"localhost", socket.gethostname().lower(), socket.getfqdn().lower(),
                        socket.getfqdn("localhost").lower(), socket.getfqdn("127.0.0.1").lower()})
    realm_hosts = "\n".join(f" {host} = {realm}" for host in hostnames)
    cygwin = Path(os.environ["QA_CYGWIN_ROOT"]) if system == "Windows" else None
    if cygwin:
        binary = cygwin / "bin"
        sbin = cygwin / "usr" / "sbin"
        os.environ["PATH"] = str(binary) + os.pathsep + os.environ["PATH"]
        def path(value): return command([binary / "cygpath.exe", "-u", str(value)])
        suffix = ".exe"
        user = command([binary / "id.exe", "-un"])
        ssh = binary / "ssh.exe"
        sshd = sbin / "sshd.exe"
        krb_bin, krb_sbin = binary, sbin
    else:
        path = lambda value: str(value)
        suffix = ""
        user = command(["id", "-un"])
        ssh = Path("/usr/bin/ssh")
        sshd = Path("/usr/sbin/sshd")
        if system == "Darwin":
            krb_root = Path(command(["brew", "--prefix", "krb5"]))
            krb_bin, krb_sbin = krb_root / "bin", krb_root / "sbin"
        else:
            krb_bin, krb_sbin = Path("/usr/bin"), Path("/usr/sbin")
    # Paths are converted for Cygwin before entering libkrb5/OpenSSH.
    conf, kdc_conf, keytab = private / "krb5.conf", private / "kdc.conf", private / "host.keytab"
    ccache = private / "ticket.ccache"
    database = private / "principal"
    conf.write_text(f"""[libdefaults]
 default_realm = {realm}
 dns_lookup_kdc = false
 dns_lookup_realm = false
 rdns = false
 dns_canonicalize_hostname = false
 qualify_shortname = ""
 udp_preference_limit = 1
[realms]
 {realm} = {{
  kdc = 127.0.0.1:{kdc_port}
 }}
[domain_realm]
{realm_hosts}
""", encoding="utf-8")
    kdc_conf.write_text(f"""[kdcdefaults]
 kdc_ports = {kdc_port}
 kdc_tcp_ports = {kdc_port}
 kdc_listen = 127.0.0.1:{kdc_port}
 kdc_tcp_listen = 127.0.0.1:{kdc_port}
[realms]
 {realm} = {{
  database_name = {path(database)}
  key_stash_file = {path(private / 'stash')}
  acl_file = {path(private / 'kadm5.acl')}
  max_life = 1h
 }}
""", encoding="utf-8")
    env = {"KRB5_CONFIG": path(conf), "KRB5_KDC_PROFILE": path(kdc_conf),
           "KRB5_KTNAME": "FILE:" + path(keytab), "KRB5CCNAME": "FILE:" + path(ccache)}
    os.environ.update(env)
    master = secret("QA_KDC_MASTER")
    command([krb_sbin / ("kdb5_util" + suffix), "create", "-s", "-r", realm, "-P", master])
    # Cygwin ships this PE executable without an .exe extension.
    kadmin = krb_sbin / "kadmin.local"
    command([kadmin, "-q", f"addprinc -randkey {user}@{realm}"])
    for hostname in hostnames:
        command([kadmin, "-q", f"addprinc -randkey host/{hostname}@{realm}"])
        command([kadmin, "-q", f"ktadd -k {path(keytab)} host/{hostname}@{realm}"])
    client_keytab = private / "client.keytab"
    command([kadmin, "-q", f"ktadd -k {path(client_keytab)} {user}@{realm}"])
    services.start_process([krb_sbin / ("krb5kdc" + suffix), "-n", "-r", realm], "kerberos-kdc")
    retry(lambda: command([krb_bin / ("kinit" + suffix), "-k", "-t", path(client_keytab), f"{user}@{realm}"]))
    host_key, client_key = private / "host_key", private / "client_key"
    keygen = (binary / "ssh-keygen.exe") if cygwin else Path("/usr/bin/ssh-keygen")
    for key in [host_key, client_key]:
        command([keygen, "-t", "ed25519", "-N", "", "-f", path(key)])
        if cygwin:
            # Windows temporary directories can inherit a group-readable ACL
            # even after Cygwin keygen's create mode. Enforce POSIX ownership
            # before sshd checks the host key (StrictModes does not bypass it).
            command([binary / "chmod.exe", "0600", path(key)])
    if system == "Windows":
        from ci_services import powershell
        powershell("Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent")
        services.cleanup_action("ssh-agent-stop", lambda: powershell("Stop-Service ssh-agent"))
        native_add = Path(os.environ["WINDIR"]) / "System32/OpenSSH/ssh-add.exe"
        # Cygwin encodes POSIX group bits as explicit Windows ACEs, which
        # Microsoft ssh-add rejects even when chmod reports 0600. Give its
        # native key copy a fresh owner-only DACL; retain the Cygwin key for sshd.
        agent_key = private / "agent_key"
        agent_key.write_bytes(client_key.read_bytes())
        os.environ["QA_AGENT_KEY_PATH"] = str(agent_key)
        powershell("$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
                   "$acl=New-Object System.Security.AccessControl.FileSecurity; "
                   "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); "
                   "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); "
                   "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:QA_AGENT_KEY_PATH -AclObject $acl")
        command([native_add, str(agent_key)])
    else:
        agent_output = command(["ssh-agent", "-s"])
        for key in ["SSH_AUTH_SOCK", "SSH_AGENT_PID"]:
            match = re.search(rf"{key}=([^;]+)", agent_output)
            if not match: raise RuntimeError("SSH agent did not publish its socket/PID")
            os.environ[key] = match.group(1)
        agent_pid = int(os.environ["SSH_AGENT_PID"])
        services.cleanup_action("ssh-agent-stop", lambda: os.kill(agent_pid, 15))
        command(["ssh-add", str(client_key)])
    authorized = private / "authorized_keys"
    original_public = Path(str(client_key) + ".pub").read_text()
    authorized.write_text(original_public)
    generated = private / "generated_key"
    encrypted = private / "encrypted_key"
    secret("QA_SSH_KEY_PASSPHRASE")
    # A key generated by the product can be authorized without a fixture-only
    # product API. The watcher observes the public file; no private bytes read.
    stop = threading.Event()
    def watch_public():
        previous = original_public
        while not stop.wait(.1):
            keys = [original_public]
            for key in (generated, encrypted):
                public = Path(str(key) + ".pub")
                if public.exists():
                    value = public.read_text().strip()
                    if value.startswith("ssh-ed25519 "):
                        keys.append(value + "\n")
            current = "".join(keys)
            if current != previous:
                authorized.write_text(current)
                previous = current
    watcher = threading.Thread(target=watch_public, daemon=True)
    watcher.start()
    services.cleanup_action("generated-key-watcher", lambda: (stop.set(), watcher.join(2)))
    commands = private / "commands"
    commands.mkdir()
    scp = commands / "scp"
    scp.write_text("#!/bin/sh\ncase \"$*\" in\n  *scp-large.bin*) exec /usr/bin/scp -l 2048 \"$@\" ;;\n  *) exec /usr/bin/scp \"$@\" ;;\nesac\n", encoding="utf-8")
    command([binary / "chmod.exe", "+x", path(scp)]) if cygwin else scp.chmod(0o700)
    config = private / "sshd_config"
    config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {path(host_key)}
PidFile {path(private / 'sshd.pid')}
AuthorizedKeysFile {path(authorized)}
StrictModes no
{'UsePAM yes' if system == 'Linux' else 'UsePAM no' if system == 'Darwin' else ''}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
GSSAPIAuthentication yes
GSSAPICleanupCredentials yes
GSSAPIStrictAcceptorCheck no
AllowUsers {user}
AllowTcpForwarding yes
X11Forwarding yes
XAuthLocation {path((binary / 'xauth.exe') if cygwin else Path('/opt/X11/bin/xauth') if system == 'Darwin' else Path('/usr/bin/xauth'))}
SetEnv "PATH={path(commands)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
Subsystem sftp internal-sftp
LogLevel DEBUG3
""", encoding="utf-8")
    prefix = [] if cygwin else ["sudo", "-n", "env", *[f"{key}={value}" for key, value in env.items()]]
    if system == "Linux": command(["sudo", "-n", "mkdir", "-p", "/run/sshd"])
    command([*prefix, sshd, "-t", "-f", path(config)])
    services.start_process([*prefix, sshd, "-D", "-e", "-f", path(config)], "ssh-features")
    probe = [ssh, "-vvv", "-F", "none", "-oBatchMode=yes", "-oGSSAPIAuthentication=yes",
             "-oPreferredAuthentications=gssapi-with-mic", "-oStrictHostKeyChecking=accept-new", "-p", str(port), "-l", user, "localhost", "printf QA_GSSAPI_OK"]
    def authenticated():
        result = subprocess.run([str(arg) for arg in probe], capture_output=True, text=True, timeout=20)
        (services.root / "ssh-gssapi-probe.log").write_text(result.stderr, encoding="utf-8")
        if result.returncode or result.stdout != "QA_GSSAPI_OK":
            raise RuntimeError("GSSAPI command roundtrip failed; see ssh-gssapi-probe.log")
    retry(authenticated)
    remote_dir = private / "remote"
    remote_dir.mkdir()
    (remote_dir / "scp-source.txt").write_text("qa-scp-roundtrip\n", encoding="utf-8")
    local_dir = private / "local"
    local_dir.mkdir()
    (local_dir / "scp-upload.txt").write_text("qa-scp-upload\n", encoding="utf-8")
    services.config["ssh_features"] = {"host": "localhost", "port": port, "user": user,
        "key_path": str(client_key).replace("\\", "/"), "generated_key": str(generated).replace("\\", "/"),
        "encrypted_key": encrypted.as_posix(), "encrypted_public_key": encrypted.as_posix() + ".pub",
        "remote_dir": path(remote_dir), "source": path(remote_dir / "scp-source.txt"),
        "local_dir": local_dir.as_posix(), "downloaded": (local_dir / "scp-source.txt").as_posix(),
        "uploaded": (remote_dir / "scp-upload.txt").as_posix(),
        "native_public_key": str(generated).replace("\\", "/") + ".pub"}
    # Separate long transfer for pause/cancel/retry acceptance. A real scp
    # bandwidth limit makes the pause observable without timing a fast loopback.
    large = remote_dir / "scp-large.bin"
    payload = b"taomni-scp-cancel-resume\n" * (1024 * 192)
    large.write_bytes(payload)
    services.config["ssh_features"].update({"large_source": path(large),
        "large_downloaded": (local_dir / large.name).as_posix(),
        "large_sha256": hashlib.sha256(payload).hexdigest()})
    return {"gssapi_command": True, "realm": realm, "port": port, "kdc_port": kdc_port,
            "runtime": "cygwin" if cygwin else "host", "ssh_version": command([ssh, "-V"])[:120]}
