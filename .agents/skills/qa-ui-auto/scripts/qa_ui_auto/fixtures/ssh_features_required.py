"""Require the job-owned SSH/Kerberos lease. Setup gaps are failures, not skips."""
import socket
import hashlib
import json
from pathlib import Path


def setup(ctx):
    config = ctx.cfg.get("ssh_features", {})
    if not all(config.get(key) for key in ["host", "port", "user", "generated_key", "remote_dir"]):
        raise RuntimeError("Real SSH/Kerberos fixture is missing; select capability ssh_features")
    with socket.create_connection((config["host"], int(config["port"])), timeout=5) as stream:
        if not stream.recv(128).startswith(b"SSH-"):
            raise RuntimeError("SSH feature fixture did not send an SSH banner")
    if str(getattr(ctx, "case_id", "")).startswith("TC-SESSION-SCP-"):
        # Represent a previous interrupted process without invoking product
        # transfer APIs. Compatibility resumes a verified prefix; fast mode
        # must safely restart a stale one. Native bytes prove both outcomes.
        local = Path(config["downloaded"])
        local.unlink(missing_ok=True)
        identity = json.dumps([config["host"], int(config["port"]), config["user"], config["source"]], separators=(",", ":"), ensure_ascii=False)
        partial = Path(str(local) + ".taomni-scp-" + hashlib.sha256(identity.encode()).hexdigest() + ".part")
        partial.write_bytes(b"qa-scp-" if ctx.case_id.endswith("001") else b"obsolete-content")
