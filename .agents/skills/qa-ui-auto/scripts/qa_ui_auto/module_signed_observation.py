"""A narrowly scoped hello-plugin oracle, with no install/state/key shortcut.

Only plugin_list and hello/ping cross the production IPC. Installation and
lifecycle mutations stay on the real UI. Fault injection edits only the exact
signed frontend file in the verified disposable profile, retaining its original
signed bytes for restoration; it never edits signatures or active pointers.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from .deadline import budget_time as time
from .steps import StepError
from .module_retained_observation import assert_code_removed, observe as observe_data
from .module_profile_observation import writer_lease

PHASES = {"installed", "enabled", "disabled", "invalid", "uninstalled", "tamper-frontend", "restore-frontend",
          "seed-data", "retained", "installed-data", "deleted"}


def validate(args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args.get("phase") not in PHASES:
        raise StepError("module_signed_probe: expected a registered phase")
    return args["phase"]


def invoke(session, command, args=None):
    # These fixed calls are owned by this oracle; YAML cannot choose commands,
    # arguments, plugin identities, arbitrary scripts or filesystem paths.
    if command not in {"plugin_list", "plugin_invoke"}:
        raise StepError("Unsupported module observation command")
    slot = json.dumps("__qaSignedModule_" + uuid.uuid4().hex)
    session.execute(
        f"window[{slot}]={{done:false}};"
        f"window.__TAURI_INTERNALS__.invoke({json.dumps(command)},{json.dumps(args or {})}).then("
        f"value=>window[{slot}]={{done:true,value}},"
        f"error=>window[{slot}]={{done:true,error:typeof error==='object'?error:{{message:String(error)}}}});return true;"
    )
    end = time.monotonic() + 15
    try:
        while time.monotonic() < end:
            # A top-level `error` in a W3C result is a driver failure. Keep
            # the observed application rejection inside its own envelope.
            envelope = session.execute(f"return {{observation: window[{slot}] || null}};")
            state = envelope.get("observation") if isinstance(envelope, dict) else None
            if isinstance(state, dict) and state.get("done"):
                return state
            time.sleep(.05)
        raise StepError("Production module observation timed out")
    finally:
        session.execute(f"delete window[{slot}];return true;")


def check(record, ping, phase):
    if not isinstance(record, dict):
        raise StepError("Expected the installed hello record from the real native registry")
    if record.get("state") != phase:
        raise StepError(f"Expected native {phase}, observed {record!r}")
    if phase == "enabled":
        expected = {"pluginId": "taomni-plugin-hello-plugin", "version": "0.1.0", "enabled": True}
        if record.get("reason") is not None or ping.get("value") != expected or "error" in ping:
            raise StepError(f"Signed host invocation did not return its real identity: {ping!r}")
    elif ping.get("error", {}).get("code") != -32009:
        raise StepError(f"Inactive native plugin did not reject invoke with InvalidState: {ping!r}")


def run(ctx, args):
    phase = validate(args)
    fixture_path = Path(ctx.case_dir) / "official-module-fixture.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    root = Path(fixture["pluginRoot"])
    if root.resolve() != root or not root.is_relative_to(Path(ctx.case_dir).resolve().parent):
        raise StepError("Plugin observation escaped the run-owned QA profile")
    module = root / "hello-plugin"
    directory = module / "versions" / "0.1.0"
    frontend = directory / "frontend/index.js"
    original = Path(ctx.case_dir) / "official-module/frontend-index.js.original"
    observation = {"phase": phase, "passed": False, "versionDirectory": str(directory)}
    try:
        if phase in {"tamper-frontend", "restore-frontend"}:
            if frontend.resolve() != frontend or not frontend.is_file():
                raise StepError("Installed frontend is absent or symlinked")
            before = hashlib.sha256(frontend.read_bytes()).hexdigest()
            clean = original.read_bytes()
            if hashlib.sha256(clean).hexdigest() != fixture["frontendSha256"]:
                raise StepError("Retained original signed frontend changed")
            if phase == "tamper-frontend" and before != fixture["frontendSha256"]:
                raise StepError("Frontend was already changed before fault injection")
            if phase == "restore-frontend" and before == fixture["frontendSha256"]:
                raise StepError("Restore requested without the expected tamper")
            frontend.write_bytes(clean + b"\n// external QA integrity fault\n" if phase == "tamper-frontend" else clean)
            observation.update(beforeSha256=before, afterSha256=hashlib.sha256(frontend.read_bytes()).hexdigest())
        else:
            listed = invoke(ctx.session, "plugin_list")
            observation["registry"] = listed
            records = listed.get("value")
            if "error" in listed or not isinstance(records, list):
                raise StepError("Real native plugin_list failed")
            matching = [record for record in records if record.get("manifest", {}).get("slug") == "hello-plugin"]
            if len(matching) != 1:
                raise StepError(f"Expected exactly one native hello record, got {matching!r}")
            record = matching[0]
            ping = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
            observation["ping"] = ping
            expected_state = {"invalid": "disabled", "seed-data": "installed", "installed-data": "installed",
                              "retained": "uninstalled", "deleted": "uninstalled"}.get(phase, phase)
            check(record, ping, expected_state)
            observation["writerLease"] = writer_lease(root, enabled=expected_state == "enabled")
            if phase == "invalid":
                if not record.get("reason"):
                    raise StepError("A changed signed frontend was not rejected on startup")
            elif record.get("manifest", {}).get("version") != "0.1.0" or record.get("reason"):
                raise StepError("Native plugin version or trust differs from the official artifact")
            if expected_state == "uninstalled":
                assert_code_removed(module)
                observation["codeAbsent"] = True
            else:
                proof = directory / ".taomni-trust/package.taomni-plugin"
                if hashlib.sha256(proof.read_bytes()).hexdigest() != fixture["sha256"]:
                    raise StepError("Installed re-verification proof does not match the signed original")
                if phase != "invalid" and hashlib.sha256(frontend.read_bytes()).hexdigest() != fixture["frontendSha256"]:
                    raise StepError("Installed frontend bytes do not match the signed original")
            pointer = json.loads((module / "active.json").read_text(encoding="utf-8"))
            observation["activePointer"] = pointer
            expected_version = None if expected_state == "uninstalled" else "0.1.0"
            if pointer["activeVersion"] != expected_version:
                raise StepError("Native active pointer differs from lifecycle state")
            if expected_state == "uninstalled" and pointer["previousVersion"] != "0.1.0":
                raise StepError("Uninstall lost the previously installed version history")
            if phase in {"seed-data", "retained", "installed-data", "deleted"}:
                observation["data"] = observe_data(root, phase, record)
        observation["passed"] = True
        return "official module " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "official-module-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, ensure_ascii=False) + "\n")
