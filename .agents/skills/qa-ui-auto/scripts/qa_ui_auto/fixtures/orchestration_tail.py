"""PARTIAL-006's synchronous read-only oracle at the explicit recovery request.

The fixture never writes product artifacts or starts/retries tasks. Capturing at
request arrival proves prefix identity before the recovery response can emit data.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .orchestration import _physical_child, _query_rows

PREFIX_FILE = "pre-recovery-prefix.json"


def capture_prefix(ctx: Any, body: dict, modules: Any) -> dict:
    manifest = modules.metadata(body, modules.PACK_MARKER)
    if not manifest or manifest.get("expected_ids") != ["tests"]:
        raise AssertionError("tail recovery must request only missing tests")
    root = Path(ctx.values["orchestration_data_root"])
    _physical_child(Path(ctx.report_root).resolve(), root)
    database = _physical_child(root, root / "state.sqlite3")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        rows = _query_rows(db, "SELECT data FROM runs WHERE id=?", (manifest["pack_id"],))
        if len(rows) != 1:
            raise AssertionError("tail recovery has no unique durable run")
        run = json.loads(rows[0][0])
        if run["status"] not in ("preparing", "running") or run["recoveryCount"] != 1:
            raise AssertionError("tail recovery was not explicitly reserved")
        ledger = _query_rows(db, "SELECT kind,state FROM request_ledger WHERE run_id=? ORDER BY rowid", (run["id"],))
        if ledger != [("main", "failed"), ("recovery", "sent")]:
            raise AssertionError("tail prefix probe requires failed main and exactly one sent recovery")
        if sorted(item["itemId"] for item in run["artifacts"]) != ["contract", "design"]:
            raise AssertionError("complete no-LF tail was not saved before recovery")
        artifacts = []
        for artifact in run["artifacts"]:
            file = _physical_child(root, root / "artifacts" / artifact["id"])
            data = file.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            stored = _query_rows(db, "SELECT hash,data FROM artifacts WHERE run_id=? AND id=?", (run["id"], artifact["id"]))
            if (digest != artifact["hash"] or data != artifact["content"].encode()
                    or len(stored) != 1 or stored[0][0] != digest or json.loads(stored[0][1]) != artifact):
                raise AssertionError("pre-recovery tail candidate disk/SQLite/run hashes disagree")
            artifacts.append({"id": artifact["id"], "item_id": artifact["itemId"], "hash": digest,
                              "path": str(file), "bytes": len(data)})
    return {"scope": "native_prefix_before_recovery_response", "run_id": run["id"],
            "revision": run["revision"], "requested_ids": manifest["expected_ids"],
            "ledger": ledger, "artifacts": artifacts}


def install_recovery_probe(ctx: Any, application: Any) -> None:
    from .orchestration import load_server
    server = load_server()
    modules = __import__("behavior")
    original = application.dispatch
    root = Path(ctx.values["orchestration_fixture_root"])

    def dispatch(method: str, path: str, body: dict | None = None):
        is_recovery = isinstance(body, dict) and any(
            line == "TAOMNI_RECOVERY=true" for text in modules.strings(body) for line in text.splitlines())
        if method == "POST" and is_recovery:
            try:
                if getattr(ctx, "orchestration_tail_prefix", None) is not None:
                    raise AssertionError("tail recovery probe received an extra request")
                prefix = capture_prefix(ctx, body, modules)
                ctx.orchestration_tail_prefix = prefix
                (root / PREFIX_FILE).write_text(json.dumps(prefix, indent=2) + "\n", encoding="utf-8")
            except (AssertionError, KeyError, OSError, ValueError, sqlite3.Error):
                ctx.orchestration_tail_probe_failed = True
                return server.Reply(422, {"error": {"type": "invalid_request_error", "message": "tail prefix evidence failed"}})
        return original(method, path, body)

    application.dispatch = dispatch


def verify_recovery_probe(ctx: Any, receipts: list[dict]) -> dict:
    prefix = getattr(ctx, "orchestration_tail_prefix", None)
    if getattr(ctx, "orchestration_tail_probe_failed", False) or not prefix or len(receipts) != 1:
        raise AssertionError("missing successful native prefix proof before recovery response")
    final = receipts[0]
    if final["run_id"] != prefix["run_id"] or prefix["requested_ids"] != ["tests"]:
        raise AssertionError("tail recovery changed run or replayed existing items")
    artifacts = {item["item_id"]: item for item in final["artifacts"]}
    if set(artifacts) != {"design", "contract", "tests"}:
        raise AssertionError("tail recovery did not add exactly missing tests")
    for previous in prefix["artifacts"]:
        if artifacts.get(previous["item_id"]) != previous:
            raise AssertionError("tail recovery replaced an existing candidate identity/hash")
    return prefix
