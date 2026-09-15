"""mysql_required: TCP-probe the configured database.host:database.port. Skip the case
if unreachable or credentials missing (FixtureSkip), with an explicit hint pointing the user
at environment variables or local config — never commit credentials to version control.
"""

from __future__ import annotations

import os
import socket
from typing import Any


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    section = cfg.get("database") or cfg.get("mysql") or {}
    host = section.get("host")
    port = section.get("port")
    if not host or not port:
        raise FixtureSkip(
            "database.host / database.port not configured in qa-ui-auto.config.yaml. "
            "Please configure your MySQL/database host and port in local uncommitted "
            "qa-ui-auto.config.yaml. Do NOT commit server connection details to version control."
        )

    user = section.get("user")
    if not user or not str(user).strip():
        raise FixtureSkip(
            "database.user not configured in qa-ui-auto.config.yaml. "
            "Please set 'user' under 'database:' in your local uncommitted "
            "qa-ui-auto.config.yaml. Do NOT commit username to version control."
        )

    env_pwd = (
        (getattr(ctx, "env", {}) or {}).get("TAOMNI_TEST_MYSQL_PASSWORD")
        or (getattr(ctx, "env", {}) or {}).get("QA_MYSQL_PASSWORD")
        or os.environ.get("TAOMNI_TEST_MYSQL_PASSWORD")
        or os.environ.get("QA_MYSQL_PASSWORD")
    )
    raw_pwd = section.get("password")
    if not env_pwd and raw_pwd and not str(raw_pwd).startswith("${"):
        env_pwd = str(raw_pwd)
        os.environ["TAOMNI_TEST_MYSQL_PASSWORD"] = env_pwd
        if hasattr(ctx, "env") and isinstance(ctx.env, dict):
            ctx.env["TAOMNI_TEST_MYSQL_PASSWORD"] = env_pwd

    if not env_pwd or not str(env_pwd).strip():
        raise FixtureSkip(
            "MySQL password is not configured. Please set the TAOMNI_TEST_MYSQL_PASSWORD environment variable "
            "(e.g. export TAOMNI_TEST_MYSQL_PASSWORD='your_password') or set 'password' under 'database:' in your "
            "local uncommitted qa-ui-auto.config.yaml. Do NOT commit passwords or credentials to version control."
        )

    try:
        with socket.create_connection((host, int(port)), timeout=2.0):
            return
    except OSError as e:
        raise FixtureSkip(
            f"database server {host}:{port} unreachable ({e}). "
            "Fix the network/VPN/firewall — qa-ui-auto does not auto-fallback."
        ) from e
