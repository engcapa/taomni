#!/usr/bin/env python3
"""Manual entry point for the qa-ui-auto local service fixtures.

Normal test runs start these services from the runner when enabled in
qa-ui-auto.config.yaml. This command remains useful for a manual probe and is
kept backward-compatible with ``fixtures.py start`` for SSH.
"""
from __future__ import annotations

import argparse
import sys

SCRIPTS_DIR = __import__("pathlib").Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.service_fixtures import (  # noqa: E402
    MYSQL_CONTAINER_NAME,
    SSH_CONTAINER_NAME,
    start_mysql,
    start_sshd,
    stop_container,
)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Start/stop local qa-ui-auto service fixtures.")
    p.add_argument("action", choices=["start", "stop", "start-mysql", "start-all"])
    p.add_argument("--service", choices=["ssh", "mysql", "all"], default="ssh")
    p.add_argument("--port", type=int, default=2222)
    p.add_argument("--user", default="testuser")
    p.add_argument("--password", default="testpass", help="disposable SSH/MySQL user password")
    p.add_argument("--root-password", default="test-root-pass")
    p.add_argument("--database", default="test")
    args = p.parse_args()
    if args.action == "stop":
        stop_container(SSH_CONTAINER_NAME)
        stop_container(MYSQL_CONTAINER_NAME)
    elif args.action in {"start", "start-all"} and args.service in {"ssh", "all"}:
        print(start_sshd(port=args.port, user=args.user, password=args.password))
        if args.action == "start":
            sys.exit(0)
    if args.action in {"start-mysql", "start-all"} or args.service in {"mysql", "all"}:
        print(
            start_mysql(
                port=3306,
                user=args.user,
                password=args.password,
                root_password=args.root_password,
                database=args.database,
            )
        )
