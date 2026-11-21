"""Verify the SSH/SFTP daemon started through the native Local servers form."""

import hashlib
import json
from pathlib import Path

from .servers_http_observation import verify_listener_closed
from .steps import StepError

CASE_ID = "TC-SERVERS-004-local-ssh-sftp-native"
SIGNED_CASE_ID = "TC-MODULES-066"
PORT = 28491
HOST = "127.0.0.1"
USER = "taomni-qa"
PASSWORD = "taomni-local-ssh-fixture"
FILE = "local-ssh.txt"
CONTENT = b"Taomni Local servers SSH fixture\n"
MARKER = b"TAOMNI_LOCAL_SSH"


def setup(ctx):
    if ctx.case_id not in {CASE_ID, SIGNED_CASE_ID} or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("The local SSH fixture requires its native Local servers case")
    root = Path(ctx.case_dir).resolve() / "sftp-root"
    root.mkdir()
    (root / FILE).write_bytes(CONTENT)
    ctx.values.update(local_servers_ssh_root=root.as_posix(), local_servers_ssh_password=PASSWORD)


def run(ctx, phase):
    fixture = ctx.fixture_context
    if fixture.case_id not in {CASE_ID, SIGNED_CASE_ID} or not fixture.values.get("local_servers_ssh_root"):
        raise StepError("The SSH observation requires its native Local servers fixture")
    if phase == "serving":
        receipt = observe()
    elif phase == "stopped":
        verify_listener_closed(HOST, PORT)
        receipt = {"listener": False}
    else:
        raise StepError("Unknown Local SSH observation phase")
    (ctx.case_dir / f"local-ssh-{phase}.json").write_text(
        json.dumps({"port": PORT, **receipt}, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified local SSH/SFTP {phase} at {HOST}:{PORT}"


def observe():
    import paramiko

    with paramiko.SSHClient() as client:
        # This client has no personal known_hosts or keys. It reaches only
        # the disposable server started by the current case on loopback.
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            HOST, PORT, username=USER, password=PASSWORD, allow_agent=False,
            look_for_keys=False, timeout=10, auth_timeout=10, banner_timeout=10,
        )
        key = client.get_transport().get_remote_server_key()
        with client.open_sftp() as sftp, sftp.open(FILE, "rb") as stream:
            body = stream.read(len(CONTENT) + 1)
        if body != CONTENT:
            raise StepError("The local SSH server returned different SFTP file bytes")
        stdin, stdout, stderr = client.exec_command("echo TAOMNI_LOCAL_SSH", get_pty=True, timeout=10)
        try:
            with stdin, stdout, stderr:
                output = stdout.read(4096)
                exit_code = stdout.channel.recv_exit_status()
        finally:
            stdout.channel.close()
        if exit_code != 0 or MARKER not in output.splitlines():
            raise StepError(f"The local SSH PTY did not return the expected marker (exit {exit_code})")
    return {
        "keyType": key.get_name(),
        "hostKeySha256": hashlib.sha256(key.asbytes()).hexdigest(),
        "fileSha256": hashlib.sha256(body).hexdigest(),
        "commandExit": exit_code,
    }
