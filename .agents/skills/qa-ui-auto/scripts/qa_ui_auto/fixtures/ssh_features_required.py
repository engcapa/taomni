"""Require the job-owned SSH/Kerberos lease. Setup gaps are failures, not skips."""
import socket


def setup(ctx):
    config = ctx.cfg.get("ssh_features", {})
    if not all(config.get(key) for key in ["host", "port", "user", "generated_key", "remote_dir"]):
        raise RuntimeError("Real SSH/Kerberos fixture is missing; select capability ssh_features")
    with socket.create_connection((config["host"], int(config["port"])), timeout=5) as stream:
        if not stream.recv(128).startswith(b"SSH-"):
            raise RuntimeError("SSH feature fixture did not send an SSH banner")
