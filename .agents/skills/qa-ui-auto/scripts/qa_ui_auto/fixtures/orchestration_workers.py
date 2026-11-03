"""Native Taomni scheduler -> installed harness -> fixture LLM evidence owner.

This helper is reached only through TC-ORCH-WORKER-004's orchestration fixture
hook. It neither starts tasks nor writes marker artifacts; YAML drives real UI.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

from .orchestration import load_server

HARNESS_NAMES = ("claude-code", "codex", "pi", "opencode", "deepseek-harness", "zcode")
PRODUCT_HARNESSES = {"claude-code": "claude_code", "deepseek-harness": "deepseek"}


def modules():
    server = load_server()
    from harness_config import CATALOG_PATH, verify_installation
    from receipts import assert_isolated_network, validate_artifact, validate_worker_events
    return server, CATALOG_PATH, verify_installation, assert_isolated_network, validate_artifact, validate_worker_events


def setup(ctx: Any) -> None:
    _, catalog_path, verify_installation, assert_network, _, _ = modules()
    if (ctx.cfg.get("app") or {}).get("mode") != "native" or sys.platform != "linux":
        raise RuntimeError("six real workers require hosted Linux native Taomni, never browser stubs")
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("six real workers are GitHub-only; local work is offline unit tests")
    assert_network()
    installation_path = Path(os.environ.get("QA_ORCHESTRATION_INSTALLATION", ""))
    if not installation_path.is_absolute() or not installation_path.is_file():
        raise RuntimeError("missing six-worker pinned installation manifest; unavailable workers cannot skip")
    installation = json.loads(installation_path.read_text())
    for name in HARNESS_NAMES:
        verify_installation(installation, name)
    root = Path(ctx.values["orchestration_data_root"])
    report = Path(ctx.report_root).resolve()
    if root.resolve() != root or not root.is_relative_to(report):
        raise RuntimeError("worker data root escaped this native QA run")
    worktrees = root / "worktrees"
    worktrees.mkdir(mode=0o700, exist_ok=True)
    ctx.orchestration_fixture.application.allow_worker_root(worktrees)
    profiles = root / "profiles.json"
    settings = json.loads(profiles.read_text())
    bridge = catalog_path.with_name("worker_bridge.py")
    python = str(Path(sys.executable).resolve())
    catalog = json.loads(catalog_path.read_text())
    case_run = "native-" + hashlib.sha256(str(Path(ctx.case_dir).resolve()).encode()).hexdigest()[:16]
    for index, name in enumerate(HARNESS_NAMES):
        resource_id = "resource-" + name
        protocol = catalog["harnesses"][name]["protocol"]
        settings["resources"].append(dict(id=resource_id, name=name, kind="worker", protocol=protocol,
            providerId="", model="fixture-worker", baseUrl=ctx.values["orchestration_base_url"], keyRef="",
            harness=PRODUCT_HARNESSES.get(name, name), binary=python,
            args=["-I", str(bridge), "--installation", str(installation_path), "--harness", name,
                  "--base-url", ctx.values["orchestration_base_url"], "--worktree", "{worktree}",
                  "--state-root", "{state_root}", "--timeout", "60"],
            costCoefficient=1, proxyMode="none", customProxy=None))
        marker = dict(mode="worker", run_id=case_run, worker_id=name,
                      marker_path="taomni-worker-marker.txt", marker_text=f"taomni:{case_run}:{name}\n")
        prompt = (f"QA real worker {index + 1}: {name}. Execute only the harmless provider-supplied Bash tool "
                  "in your actual assigned worktree, then return the final worker result unchanged. "
                  "Do not install dependencies, delegate, commit, push or use external network.\n"
                  "TAOMNI_ORCHESTRATION_FIXTURE=" + json.dumps(marker, separators=(",", ":")))
        ctx.values["orchestration_worker_prompt_" + str(index + 1)] = prompt
    settings.update(workerResourceIds=["resource-claude-code"], concurrency=1)
    profiles.write_text(json.dumps(settings), encoding="utf-8")
    ctx.orchestration_workers_expected = dict(run_id=case_run, installation=installation,
                                              catalog=catalog, project=Path(ctx.values["orchestration_project"]))


def git_output(project: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(project), *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    if result.returncode:
        raise AssertionError("native worker Git ownership check failed")
    return result.stdout


def verify_database(root: Path, expected: dict, events: list[dict], validate_artifact,
                    validate_worker_events) -> list[dict]:
    db_path = root / "state.sqlite3"
    if not db_path.is_file():
        raise AssertionError("native scheduler never persisted its task database")
    connection = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("BEGIN")
        rows = connection.execute("SELECT id,status,data FROM runs").fetchall()
        if len(rows) != 6:
            raise AssertionError("native scheduler must persist exactly six independently submitted worker tasks")
        snapshots = [json.loads(row[2]) for row in rows]
        roots = [Path(snapshot.get("worktreePath") or "") for snapshot in snapshots]
        if len(set(roots)) != 6:
            raise AssertionError("native worker tasks reused an assigned worktree")
        receipts, seen = [], set()
        for run_id, status, data in rows:
            snapshot = json.loads(data)
            resource_ids = snapshot["settingsSnapshot"]["workerResourceIds"]
            if len(resource_ids) != 1:
                raise AssertionError("each task must freeze exactly one explicitly selected real worker")
            resource = next(item for item in snapshot["settingsSnapshot"]["resources"] if item["id"] == resource_ids[0])
            name = resource["name"]
            if name not in HARNESS_NAMES or name in seen:
                raise AssertionError("native worker coverage has missing or duplicated harness identity")
            seen.add(name)
            if (status != "candidate" or snapshot["status"] != "candidate" or snapshot["intent"] != "develop"
                    or snapshot["requestCount"] != 1 or snapshot["recoveryCount"] != 0 or snapshot.get("error")):
                raise AssertionError("real native worker task did not reach an evidence-backed candidate once")
            tasks = connection.execute("SELECT id,status FROM tasks WHERE run_id=?", (run_id,)).fetchall()
            if tasks != [("implementation", "candidate")]:
                raise AssertionError("native worker implementation task was not persisted as candidate")
            ledger = connection.execute("SELECT kind,state FROM request_ledger WHERE run_id=?", (run_id,)).fetchall()
            attempts = connection.execute("SELECT state,owner FROM attempts WHERE run_id=?", (run_id,)).fetchall()
            if ledger != [("main", "completed")] or len(attempts) != 1 or attempts[0][0] != "completed" or not attempts[0][1]:
                raise AssertionError("native request ledger/attempt ownership or terminal state is inconsistent")
            worktree = Path(snapshot["worktreePath"])
            if worktree.parent != root / "worktrees" or worktree.name != run_id:
                raise AssertionError("worker worktree is not owned by its persisted native task ID")
            marker = validate_artifact(worktree, f"taomni:{expected['run_id']}:{name}\n", roots, expected["project"])
            owner = worktree / ".taomni-orchestration-owner"
            if not owner.is_file() or owner.is_symlink() or owner.read_text() != run_id:
                raise AssertionError("native worktree owner file does not match its persisted run UUID")
            changes = git_output(worktree, "status", "--porcelain", "--untracked-files=all").decode().splitlines()
            if changes != ["?? .taomni-orchestration-owner", "?? taomni-worker-marker.txt"]:
                raise AssertionError("native worktree must contain exactly its host owner and harmless worker marker")
            frozen = snapshot.get("sourceRevision")
            if (not frozen or git_output(worktree, "rev-parse", "HEAD").decode().strip() != frozen
                    or git_output(expected["project"], "rev-parse", "HEAD").decode().strip() != frozen):
                raise AssertionError("native worker changed or did not freeze its base commit")
            rows_artifact = connection.execute("SELECT item_id,hash,data FROM artifacts WHERE run_id=?", (run_id,)).fetchall()
            if len(rows_artifact) != 1 or rows_artifact[0][0] != "implementation":
                raise AssertionError("native worker candidate summary was not persisted independently")
            artifact = json.loads(rows_artifact[0][2])
            content = artifact["content"].encode()
            digest = hashlib.sha256(content).hexdigest()
            disk = root / "artifacts" / artifact["id"]
            if (not disk.is_file() or disk.is_symlink() or disk.read_bytes() != content
                    or digest != artifact["hash"] or digest != rows_artifact[0][1]
                    or snapshot["artifacts"] != [artifact]):
                raise AssertionError("native candidate database, snapshot and disk hashes differ")
            final = json.loads(artifact["content"])
            if (final.get("type") != "worker_result" or final.get("status") != "completed"
                    or final.get("worker_id") != name or final.get("run_id") != expected["run_id"]):
                raise AssertionError("native candidate summary does not belong to this real worker task")
            bridge = json.loads((root / "worker-state" / run_id / "bridge-receipt.json").read_text())
            process = bridge["fixture_evidence"]
            installed = expected["installation"]["harnesses"][name]
            if (bridge.get("is_error") or process.get("exit_code") != 0 or process.get("harness") != name
                    or process.get("cwd") != str(worktree) or not process.get("pid")
                    or process["identity"]["entrypoint_sha256"] != installed["entrypoint_sha256"]
                    or process.get("protocol") != installed["protocol"] or not process.get("matching_final_result")):
                raise AssertionError("native supervisor did not launch the pinned installed real harness")
            wire = validate_worker_events(events, name, installed["protocol"])
            receipts.append(dict(harness=name, native_run_id=run_id, status="candidate", source_revision=frozen, request_count=1,
                                 recovery_count=0, artifact_sha256=digest, marker=marker, wire=wire,
                                 process={key: process[key] for key in ("harness", "pid", "cwd", "exit_code", "identity", "protocol", "stdout_sha256", "event_types")}))
        if seen != set(HARNESS_NAMES) or git_output(expected["project"], "status", "--porcelain"):
            raise AssertionError("native worker matrix incomplete or source project modified")
        generation = [event for event in events if event.get("route") in {"openai_chat", "openai_responses", "anthropic_messages"}]
        if len(generation) != 12:
            raise AssertionError("native six workers must issue exactly twelve real LLM tool/final requests")
        return receipts
    finally:
        connection.close()


def teardown(ctx: Any) -> None:
    _, _, _, _, validate_artifact, validate_worker_events = modules()
    expected = getattr(ctx, "orchestration_workers_expected", None)
    if expected is None:
        raise AssertionError("six-worker native fixture did not finish setup")
    output = Path(ctx.case_dir) / "native-six-workers.receipt.json"
    report = dict(scope="native_taomni_ui_scheduler_real_six_harnesses", status="failed", required_harnesses=list(HARNESS_NAMES))
    try:
        report["workers"] = verify_database(Path(ctx.values["orchestration_data_root"]), expected,
            list(ctx.orchestration_fixture.application.events), validate_artifact, validate_worker_events)
        report["status"] = "passed"
    finally:
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
