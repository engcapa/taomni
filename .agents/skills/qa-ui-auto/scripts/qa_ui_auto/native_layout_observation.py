"""Read the isolated app's committed layout independently of its WebView/IPC."""
from __future__ import annotations

import hashlib
import json
from contextlib import closing
from pathlib import Path
import sqlite3

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env
from .steps import StepError


def observe(ctx, expected: dict) -> None:
    harness = getattr(ctx.session, "_harness", None)
    if harness is None:
        raise StepError("assert_native_layout requires the run-owned native harness")
    environment = native_isolation_env(Path(harness.report_root))
    data = Path(environment.get("NEWMOB_DATA_DIR") or environment["XDG_DATA_HOME"]) / QA_APP_ID
    database = data / "taomni.db"
    if database.resolve() != database or not database.resolve().is_relative_to(Path(harness.report_root).resolve()):
        raise StepError("Native layout database must stay inside the isolated report root without symlinks")
    observation = {"database": str(database), "expected": expected, "passed": False}
    try:
        # mode=ro also prevents an absent database from being manufactured by
        # the oracle. Neither renderer state nor a product IPC supplies the data.
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)) as connection:
            row = connection.execute("SELECT layout FROM shell_layout WHERE id = 1").fetchone()
        if row is None:
            raise StepError("Native layout has no committed record")
        layout = json.loads(row[0])
        observation["raw_sha256"] = hashlib.sha256(row[0].encode("utf-8")).hexdigest()
        observation["observed"] = {
            "navigator_width": layout.get("navigator", {}).get("width"),
            "workspace_count": sum(source.get("kind") == "workspace" for source in layout.get("restoreSources", {}).values()),
        }
        if layout.get("version") != 2 or observation["observed"] != expected:
            raise StepError("Committed native layout does not match the expected preferences/restore intentions")
        observation["passed"] = True
    except (OSError, sqlite3.Error, ValueError, AttributeError, TypeError, StepError) as error:
        observation["error"] = str(error)
        raise StepError(str(error)) from error
    finally:
        ctx.case_dir.mkdir(parents=True, exist_ok=True)
        with (ctx.case_dir / "native-layout-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
