"""ssh_required: TCP-probe the configured ssh.host:ssh.port. Skip the case
if unreachable (FixtureSkip), with an explicit hint pointing the user at
the network — never auto-fall back to a docker fixture.
"""

from __future__ import annotations

import os
import socket
from typing import Any


def setup(ctx: Any, *, section_name="ssh", password_env="QA_SSH_PASSWORD") -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    section = cfg.get(section_name) or {}
    host = section.get("host")
    port = section.get("port")
    if not host or not port:
        raise FixtureSkip(
            f"{section_name}.host / {section_name}.port not configured in qa-ui-auto.config.yaml. "
            "Please configure your SSH host and port in local uncommitted "
            "qa-ui-auto.config.yaml. Do NOT commit server connection details to version control."
        )

    user = section.get("user")
    if not user or not str(user).strip():
        raise FixtureSkip(
            f"{section_name}.user not configured in qa-ui-auto.config.yaml. "
            f"Please set 'user' under '{section_name}:' in your local uncommitted "
            "qa-ui-auto.config.yaml. Do NOT commit username to version control."
        )

    env_pwd = (getattr(ctx, "env", {}) or {}).get(password_env) or os.environ.get(password_env)
    raw_pwd = section.get("password")
    if not env_pwd and raw_pwd and not str(raw_pwd).startswith("${"):
        env_pwd = str(raw_pwd)
        os.environ[password_env] = env_pwd
        if hasattr(ctx, "env") and isinstance(ctx.env, dict):
            ctx.env[password_env] = env_pwd

    if not env_pwd or not str(env_pwd).strip():
        raise FixtureSkip(
            f"SSH password is not configured. Please set the {password_env} environment variable "
            f"(e.g. export {password_env}='your_password') or set 'password' under '{section_name}:' in your "
            "local uncommitted qa-ui-auto.config.yaml. Do NOT commit passwords or credentials to version control."
        )

    try:
        with socket.create_connection((host, int(port)), timeout=2.0):
            return
    except OSError as e:
        raise FixtureSkip(
            f"{section_name} server {host}:{port} unreachable ({e}). "
            "Fix the network/VPN/firewall — qa-ui-auto does not auto-fallback."
        ) from e
