"""Fixed native transfer input and independent disk/HTTP observations."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from .deadline import budget_time as time
from .fixtures.module_download import CHUNK, PAYLOAD, TASK_ID, plugin_root, state
from .steps import StepError

PHASES = {"start", "advance-background", "cancelled", "recovered", "proxy-failed", "finish", "completed", "forgotten"}


def invoke(session, command, args=None):
    if command not in {"plugin_download_start", "plugin_download_list"}:
        raise StepError("Unsupported download observation command")
    slot = json.dumps("__qaModuleDownload_" + uuid.uuid4().hex)
    session.execute(f"window[{slot}]={{done:false}};window.__TAURI_INTERNALS__.invoke("
                    f"{json.dumps(command)},{json.dumps(args or {})}).then("
                    f"value=>window[{slot}]={{done:true,value}},error=>window[{slot}]={{done:true,error:String(error)}});return true;")
    try:
        end = time.monotonic() + 15
        while time.monotonic() < end:
            envelope = session.execute(f"return {{observation:window[{slot}]||null}};")
            result = envelope.get("observation") if isinstance(envelope, dict) else None
            if isinstance(result, dict) and result.get("done"):
                if "error" in result:
                    raise StepError(f"Production download observation rejected: {result['error']}")
                return result["value"]
            time.sleep(.05)
        raise StepError("Native download observation timed out")
    finally:
        session.execute(f"delete window[{slot}];return true;")


def wait_for(check, message):
    end = time.monotonic() + 10
    while time.monotonic() < end:
        if check():
            return
        time.sleep(.05)
    raise StepError(message)


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args.get("phase") not in PHASES:
        raise StepError("module_download_probe: expected a fixed registered phase")
    phase = args["phase"]
    origin = state(ctx)
    root = plugin_root(ctx)
    partial = root / ".downloads" / "qa-module.part"
    completed = root / ".downloads" / "qa-module.pkg"
    observation = {"phase": phase, "passed": False}
    try:
        if phase == "start":
            invoke(ctx.session, "plugin_download_start", {
                "id": TASK_ID, "url": f"http://127.0.0.1:{origin.server.server_port}/module.pkg",
                "partialPath": str(partial), "completedPath": str(completed),
                "expectedTotal": len(PAYLOAD), "expectedSha256": hashlib.sha256(PAYLOAD).hexdigest(),
            })
            wait_for(lambda: partial.exists() and partial.stat().st_size == CHUNK, "Initial partial bytes were not written")
        elif phase == "advance-background":
            origin.advance.set()
            wait_for(lambda: partial.stat().st_size >= CHUNK * 2, "Closing Settings stopped native download progress")
        elif phase == "finish":
            origin.finish.set()
        else:
            listed = invoke(ctx.session, "plugin_download_list")
            tasks = [task for task in listed["tasks"] if task.get("id") == TASK_ID]
            records = origin.records()
            observation.update(listing=listed, origin=records)
            if phase == "forgotten":
                if tasks or not completed.is_file() or completed.read_bytes() != PAYLOAD:
                    raise StepError("Forgetting a task must keep its verified completed bytes")
            elif len(tasks) != 1:
                raise StepError("Expected exactly one durable native download task")
            elif phase == "completed":
                if tasks[0]["progress"]["phase"] != "completed" or partial.exists() or completed.read_bytes() != PAYLOAD:
                    raise StepError("Completed transfer did not atomically publish the exact verified bytes")
                if len(records) != 2 or records[1]["offset"] != CHUNK * 2:
                    raise StepError("Resume did not request the exact retained byte Range")
            else:
                expected = "failed" if phase == "proxy-failed" else "cancelled"
                if tasks[0]["progress"]["phase"] != expected or completed.exists() or partial.read_bytes() != PAYLOAD[:CHUNK * 2]:
                    raise StepError("Cancellation/recovery/proxy failure changed the safe prefix or published an incomplete file")
                if len(records) != 1:
                    raise StepError("Recovery or a configured proxy failure unexpectedly opened a direct origin connection")
                wait_for(lambda: origin.records()[0]["disconnected"], "Cancellation did not stop the HTTP connection")
                if phase == "proxy-failed" and not tasks[0]["progress"].get("error"):
                    raise StepError("Proxy failure did not expose an actionable native error")
            observation["partialBytes"] = partial.stat().st_size if partial.exists() else None
            observation["completedSha256"] = hashlib.sha256(completed.read_bytes()).hexdigest() if completed.exists() else None
        observation["passed"] = True
        return "module download " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-download-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, ensure_ascii=False) + "\n")
