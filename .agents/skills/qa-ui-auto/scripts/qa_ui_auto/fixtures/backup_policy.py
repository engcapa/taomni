"""Seed a disabled daily policy in the current native QA profile.

The case enables it through Settings and uses the real background timer, IPC,
SQLite snapshots and archive reader. No scheduler clock or product hook is mocked.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env


def isolated_data_root(ctx: Any) -> Path:
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("backup_policy requires an isolated native run")
    report_root = Path(ctx.report_root).resolve()
    expected = native_isolation_env(report_root)
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("backup_policy requires the current run's isolation environment")
    data_root = Path(expected.get("NEWMOB_DATA_DIR") or expected["XDG_DATA_HOME"]) / QA_APP_ID
    if data_root.resolve() != data_root or not data_root.is_relative_to(report_root):
        raise RuntimeError("backup_policy refuses a profile outside the run root")
    data_root.mkdir(parents=True, exist_ok=True)
    return data_root


def setup(ctx: Any) -> None:
    data_root = isolated_data_root(ctx)
    policy_path = data_root / "backup_policy.json"
    policy = {
        "autoBackupEnabled": False,
        "frequency": "daily",
        "maxRetainedCopies": 2,
        "defaultScope": "core",
        "customBackupDir": None,
        "lastBackupAt": None,
    }
    policy_path.write_text(json.dumps(policy, indent=2) + "\n", encoding="utf-8")
    ctx.values["backup_policy_path"] = str(policy_path)
    # Two days is due for daily but still inside the weekly interval.
    expired_at = int(time.time() * 1_000) - 2 * 24 * 60 * 60 * 1_000
    ctx.values["backup_expired_daily_policy"] = json.dumps({
        **policy, "autoBackupEnabled": True, "lastBackupAt": expired_at,
    })
    ctx.values["backup_disabled_expired_policy"] = json.dumps({
        **policy, "maxRetainedCopies": 30, "lastBackupAt": expired_at,
    })
