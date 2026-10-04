"""Lazily start the real case-owned SSH/SFTP endpoint for native cases."""
from pathlib import Path
import hashlib


def setup(ctx):
    # CI planning imports all fixture registrations with no protocol dependencies.
    from ..shell_sftp_service import ShellSftpServer
    import paramiko
    if ctx.cfg.get("app", {}).get("mode") != "native":
        raise RuntimeError("shell_sftp_server is a real native protocol fixture")
    root = Path(ctx.case_dir).resolve() / "sftp-endpoint"
    root.mkdir(parents=True, exist_ok=True)
    server = ShellSftpServer(root)
    ctx.shell_sftp_server = server
    payload = bytes(range(256)) * 65536
    (server.remote / "download 中文.bin").write_bytes(payload)
    (root / "local").mkdir()
    (root / "local" / "upload 中文.bin").write_bytes(payload)
    (root / "local" / "cancel 中文.bin").write_bytes(payload)
    ctx.env["QA_SHELL_SFTP_PASSWORD"] = server.password
    ctx.values.update(shell_sftp_port=str(server.port), shell_sftp_local=(root / "local").as_posix(), shell_sftp_remote=server.remote.as_posix(), shell_sftp_sha256=hashlib.sha256(payload).hexdigest())
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect("127.0.0.1", port=server.port, username="qa", password=server.password, look_for_keys=False, allow_agent=False, timeout=10)
        with client.open_sftp() as sftp:
            if sftp.stat("/download 中文.bin").st_size != len(payload):
                raise RuntimeError("QA SFTP metadata readiness failed")
    except Exception:
        server.stop()
        raise
    finally:
        client.close()


def teardown(ctx):
    server = getattr(ctx, "shell_sftp_server", None)
    if server:
        server.stop()
