"""Shared orchestration LLM fixture, without changes to product settings or code.

Registry/schema/cases are owned by the integration coordinator. Exposes a fresh
loopback endpoint on every platform; renderer stubs alone are not native proof.
"""
from __future__ import annotations

import hashlib
import importlib.util
import sys
import json
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Any


def load_server():
    root = next((parent for parent in Path(__file__).resolve().parents
                 if (parent / "qa-ui-auto-tests" / "fixtures" / "orchestration" / "server.py").is_file()), None)
    if root is None:
        raise RuntimeError("cannot find checked-in orchestration fixture server")
    module_dir = root / "qa-ui-auto-tests" / "fixtures" / "orchestration"
    # The trusted fixture modules are loaded from the repository, never from
    # test worktrees or the user's import paths. Server CLI works under -I too.
    name = "taomni_orchestration_fixture_server"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, module_dir / "server.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load orchestration fixture server")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def setup(ctx: Any) -> None:
    case_dir = Path(ctx.case_dir).resolve()
    report_root = Path(getattr(ctx, "report_root", case_dir.parent)).resolve()
    if not case_dir.is_relative_to(report_root):
        raise RuntimeError("orchestration fixture must stay inside the current QA report")
    fixture_root = case_dir / "orchestration-fixture"
    fixture_root.mkdir(mode=0o700, exist_ok=False)
    mode = (ctx.cfg.get("app") or {}).get("mode", "browser")
    running = load_server().start_fixture(fixture_root / "requests.ndjson") if mode == "native" else None
    ctx.orchestration_fixture = running
    ctx.values.update(orchestration_base_url=running.base_url if running else "http://127.0.0.1:9/v1",
                      orchestration_request_log=str(fixture_root / "requests.ndjson"),
                      orchestration_fixture_root=str(fixture_root),
                      orchestration_complete_model="fixture-complete",
                      orchestration_partial_model="fixture-partial")
    _seed_isolated_configuration(ctx, fixture_root, ctx.values["orchestration_base_url"])
    if str(ctx.case_id) == "TC-ORCH-WORKER-004":
        from . import orchestration_workers
        orchestration_workers.setup(ctx)


def _seed_isolated_configuration(ctx: Any, fixture_root: Path, base_url: str) -> None:
    mode = (ctx.cfg.get("app") or {}).get("mode", "browser")
    project = fixture_root / "project"
    project.mkdir(mode=0o700)
    (project / "AGENTS.md").write_text("# QA project\nPreserve APIs. Produce evidence-backed candidates. Never claim unexecuted tests passed.\n", encoding="utf-8")
    (project / "spec.md").write_text("Design a settings field, compatible IPC and a focused test plan.\n", encoding="utf-8")
    subprocess.run(["git", "init", "--quiet", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "-c", "user.name=QA Fixture", "-c", "user.email=qa@example.invalid", "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "-c", "user.name=QA Fixture", "-c", "user.email=qa@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture baseline"], check=True)
    model = "fixture-partial" if "PARTIAL" in str(ctx.case_id).upper() else "fixture-complete"
    resources = []
    for protocol in ("openai_chat", "openai_responses", "anthropic_messages"):
        resources.append(dict(id=protocol, name=protocol, kind="api", protocol=protocol,
                              providerId="", model=model, baseUrl=base_url, keyRef="", harness="claude_code",
                              binary="", args=[], costCoefficient=1, proxyMode="none", customProxy=None))
    planner = "openai_chat" if str(ctx.case_id) == "TC-ORCH-005" else "anthropic_messages"
    settings = dict(revision=1, name="Shared QA plan", planningResourceId=planner,
                    reviewResourceId="openai_responses", workerResourceIds=[], concurrency=2,
                    preferPackedPlanning=True, resources=resources)
    if mode == "browser":
        root = "/preview"
        ctx.page.goto(ctx.cfg["app"]["base_url"], wait_until="commit")
        (fixture_root / "evidence.json").write_text(json.dumps({
            "scope": "browser_stub_only_not_native_http_disk_or_ledger_evidence",
            "case_id": str(ctx.case_id), "real_http_requests": 0,
        }, indent=2) + "\n", encoding="utf-8")
        ctx.page.evaluate("""async ({settings}) => {
          localStorage.setItem('taomni.orchestration.settings', JSON.stringify(settings));
          localStorage.removeItem('taomni.orchestration.runs');
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsWriteText('/preview/AGENTS.md', 'Preserve existing contracts.');
          await vfs.vfsWriteText('/preview/spec.md', 'Settings field and interface design.');
        }""", {"settings": settings})
    else:
        from tauri_webdriver import native_isolation_env
        from native_build import QA_APP_ID
        expected = native_isolation_env(Path(ctx.report_root).resolve())
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise RuntimeError("orchestration requires verified current-run native isolation")
        data = Path(expected.get("NEWMOB_DATA_DIR") or expected["XDG_DATA_HOME"]) / QA_APP_ID
        if not data.is_relative_to(Path(ctx.report_root).resolve()) or data.resolve() != data:
            raise RuntimeError("orchestration data root escaped QA isolation")
        target = data / "orchestration"
        target.mkdir(parents=True, exist_ok=True)
        (target / "profiles.json").write_text(json.dumps(settings), encoding="utf-8")
        ctx.values["orchestration_data_root"] = str(target)
        root = project.as_posix()
    ctx.values["orchestration_project"] = root


API_CASES = {
    "TC-ORCH-001": {"requests": [], "intents": ["plan", "review"], "items": []},
    "TC-ORCH-PARTIAL-002": {"requests": ["anthropic_messages", "anthropic_messages"],
                            "intents": ["plan"], "items": ["design", "contract", "tests"]},
    "TC-ORCH-003": {"requests": ["openai_responses"], "intents": ["review"], "items": ["review"]},
    "TC-ORCH-005": {"requests": ["openai_chat"], "intents": ["plan"], "items": ["design", "contract", "tests"]},
}


def _physical_child(root: Path, child: Path) -> Path:
    if child.resolve() != child or not child.is_relative_to(root):
        raise AssertionError("orchestration evidence escaped its verified physical QA root")
    return child


def _verify_native(ctx: Any, events: list[dict]) -> dict:
    expectation = API_CASES[str(ctx.case_id)]
    root = Path(ctx.values["orchestration_data_root"])
    report_root = Path(ctx.report_root).resolve()
    _physical_child(report_root, root)
    database = _physical_child(root, root / "state.sqlite3")
    if not database.is_file():
        raise AssertionError("native orchestration database was not created")
    if [event.get("route") for event in events] != expectation["requests"]:
        raise AssertionError("native generation protocol/count differs from the explicit case budget")
    if any(event.get("method") != "POST" or event.get("status") != 200
           or event.get("streaming") is not True or not event.get("request_sha256")
           or event.get("tool_name") is not None or event.get("worker_digest") is not None for event in events):
        raise AssertionError("native API receipt is not an independent successful streaming generation")
    scenarios = ["partial", "complete"] if str(ctx.case_id) == "TC-ORCH-PARTIAL-002" else ["complete"] * len(events)
    if [event.get("scenario") for event in events] != scenarios:
        raise AssertionError("partial/recovery fixture sequence is incorrect")
    if len({event["request_id"] for event in events}) != len(events):
        raise AssertionError("duplicate native generation request identity")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        runs = [json.loads(row[0]) for row in db.execute("SELECT data FROM runs ORDER BY created_at, rowid")]
        if [run["intent"] for run in runs] != expectation["intents"]:
            raise AssertionError("native durable runs do not match the submitted tasks")
        receipts = []
        total_requests = 0
        for run in runs:
            total_requests += run["requestCount"]
            if run["worktreePath"] is not None:
                raise AssertionError("direct API task unexpectedly created a coding worktree")
            if Path(run["projectPath"]).resolve() != Path(ctx.values["orchestration_project"]).resolve():
                raise AssertionError("native task was created against another project's source root")
            requests = list(db.execute("SELECT kind,state FROM request_ledger WHERE run_id=? ORDER BY rowid", (run["id"],)))
            attempts = list(db.execute("SELECT state FROM attempts WHERE run_id=? ORDER BY rowid", (run["id"],)))
            if len(requests) != run["requestCount"] or len(attempts) != len(requests):
                raise AssertionError("native run, request ledger and attempt counts disagree")
            for source in run["sources"]:
                if hashlib.sha256(source["content"].encode()).hexdigest() != source["hash"]:
                    raise AssertionError("native context snapshot hash mismatch")
            artifact_rows = {row[0]: (row[1], json.loads(row[2])) for row in db.execute(
                "SELECT id,hash,data FROM artifacts WHERE run_id=?", (run["id"],))}
            artifacts = []
            for artifact in run["artifacts"]:
                file = _physical_child(root, root / "artifacts" / artifact["id"])
                content = file.read_bytes()
                digest = hashlib.sha256(content).hexdigest()
                stored = artifact_rows.get(artifact["id"])
                if (artifact["status"] != "candidate" or digest != artifact["hash"]
                        or content != artifact["content"].encode() or stored != (digest, artifact)):
                    raise AssertionError("native artifact disk bytes, SQLite row and run snapshot disagree")
                artifacts.append({"id": artifact["id"], "item_id": artifact["itemId"], "hash": digest,
                                  "path": str(file), "bytes": len(content)})
            if len(artifact_rows) != len(artifacts):
                raise AssertionError("native run lost or duplicated a durable candidate")
            if sorted(artifact["item_id"] for artifact in artifacts) != sorted(expectation["items"]):
                raise AssertionError("native complete candidates differ from the expected document set")
            if not expectation["requests"]:
                if run["status"] != "planned" or run["recoveryCount"] or run["events"]:
                    raise AssertionError("unapproved settings case performed execution")
            else:
                if run["status"] != "candidate" or run["error"] is not None:
                    raise AssertionError("native task did not finish as an unaccepted candidate")
                expected_ledger = [("main", "failed"), ("recovery", "completed")] if len(events) == 2 else [("main", "completed")]
                if requests != expected_ledger or [row[0] for row in attempts] != [row[1] for row in requests]:
                    raise AssertionError("native recovery/attempt ledger was retried or left incomplete")
                if run["recoveryCount"] != (1 if len(events) == 2 else 0):
                    raise AssertionError("native recovery authorization count is incorrect")
                snapshot = run["settingsSnapshot"]
                resource_id = snapshot["reviewResourceId"] if run["intent"] == "review" else snapshot["planningResourceId"]
                resource = next((item for item in snapshot["resources"] if item["id"] == resource_id), None)
                if not resource or resource["kind"] != "api" or resource["protocol"] != events[0]["route"]:
                    raise AssertionError("native HTTP protocol differs from the task's frozen API resource")
                stored_events = [json.loads(row[0]) for row in db.execute(
                    "SELECT data FROM events WHERE run_id=? ORDER BY sequence", (run["id"],))]
                if stored_events != run["events"]:
                    raise AssertionError("native event rows differ from the run snapshot")
                kinds = [event["kind"] for event in run["events"]]
                if kinds.count("request_sent") != len(events) or kinds.count("candidate_saved") != len(artifacts):
                    raise AssertionError("native event ledger lost requests or candidate publications")
            receipts.append({"run_id": run["id"], "status": run["status"], "intent": run["intent"],
                             "settings_revision": run["settingsSnapshot"]["revision"],
                             "settings_name": run["settingsSnapshot"]["name"], "requests": requests,
                             "recovery_count": run["recoveryCount"], "artifacts": artifacts})
        if total_requests != len(events):
            raise AssertionError("native HTTP generation total differs from the durable request ledger")
        profiles = json.loads((root / "profiles.json").read_text(encoding="utf-8"))
        if str(ctx.case_id) == "TC-ORCH-001":
            if ([run["settingsSnapshot"]["name"] for run in runs] != ["Shared QA plan", "Updated shared defaults"]
                    or profiles["name"] != "Updated shared defaults"
                    or runs[0]["settingsSnapshot"]["revision"] >= runs[1]["settingsSnapshot"]["revision"]):
                raise AssertionError("shared settings save/cancel rewrote a historical snapshot")
    return {"scope": "native_product_api_http_sqlite_candidate_files", "case_id": str(ctx.case_id),
            "status": "passed", "requests": events, "runs": receipts}


def teardown(ctx: Any) -> None:
    running = getattr(ctx, "orchestration_fixture", None)
    if running is None:
        return
    try:
        if str(ctx.case_id) == "TC-ORCH-WORKER-004":
            from . import orchestration_workers
            orchestration_workers.teardown(ctx)
        elif str(ctx.case_id) in API_CASES:
            root = Path(ctx.values["orchestration_fixture_root"])
            try:
                evidence = _verify_native(ctx, list(running.application.events))
            except (AssertionError, OSError, sqlite3.Error, KeyError, ValueError) as error:
                (root / "evidence.json").write_text(json.dumps({
                    "scope": "native_product_api_http_sqlite_candidate_files", "status": "failed",
                    "case_id": str(ctx.case_id), "error": str(error),
                }, indent=2) + "\n", encoding="utf-8")
                raise
            (root / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    finally:
        running.close()
        ctx.orchestration_fixture = None
