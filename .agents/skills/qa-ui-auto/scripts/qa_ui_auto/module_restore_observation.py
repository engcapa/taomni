"""Independent module restore observations for cold starts and UI relaunches.

YAML cannot choose commands, credentials, paths or file contents. The Settings
UI installs packages, changes lifecycle and creates the archive. The original staging phases use
the production IPC without its UI's automatic relaunch; native_restart_app then
proves normal shutdown and apply with the retained profile. This deliberately
does not claim native coverage of the restore dialog's automatic relaunch.
The separate ui-ready/ui-restored phases require the real confirmation and
native process observation supplied by native_confirm_restore_relaunch.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
import zipfile

from .deadline import budget_time as time
from .module_backup_observation import wait_manual_job
from .module_live_backup_observation import VALUES, check_archive
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .module_restore_retained_observation import check_retained_sqlite
from .module_signed_observation import invoke
from .steps import StepError

MASTER_PASSWORD = "qa-module-restore-original"
CHANGED_PASSWORD = "qa-module-restore-changed"
ARCHIVE_STATES = {"running-archive": "enabled", "disabled-archive": "disabled", "retained-archive": "uninstalled"}
PHASES = {"write-original", "write-mutated", "reject-password", "stage", "staged", "restored", "restart-persisted", "ui-ready", "ui-restored"} | set(ARCHIVE_STATES)
RESTORE_PATHS = ("restore_intent.json", "restore_journal.json", ".pending_restore")


def validate(args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args.get("phase") not in PHASES:
        raise StepError("module_restore_probe requires one registered phase")
    return args["phase"]


def generation(profile):
    value = json.loads((profile / ".profile-state.json").read_text(encoding="utf-8"))["generation"]
    if str(uuid.UUID(value)) != value:
        raise StepError("Restore profile generation is not a canonical UUID")
    return value


def require_clean(profile):
    if any((profile / name).exists() or (profile / name).is_symlink() for name in RESTORE_PATHS):
        raise StepError("Unexpected pending restore state")


def rows(path):
    ordinary(path)
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise StepError("Restored module database failed integrity check")
        return [row[0] for row in db.execute("SELECT value FROM entries ORDER BY id")]


def check_generation(state, current, *, persisted=False):
    if current == state["generation"]:
        raise StepError("Applied restore did not advance the profile generation")
    if persisted and current != state.get("restoredGeneration"):
        raise StepError("Ordinary restart changed the restored generation")


def record(ctx):
    reply = invoke(ctx.session, "plugin_list")
    if "error" in reply or not isinstance(reply.get("value"), list):
        raise StepError("Cannot observe the native module registry")
    matching = [item for item in reply["value"] if item.get("manifest", {}).get("slug") == "hello-plugin"]
    if len(matching) != 1 or matching[0].get("reason") is not None:
        raise StepError("Restore requires exactly one trusted hello module record")
    return matching[0]


def business(ctx, command, values):
    payload = {"value": values[-1]} if command == "hello/write" else None
    args = {"slug": "hello-plugin", "command": command}
    if payload is not None:
        args["payload"] = payload
    reply = invoke(ctx.session, "plugin_invoke", args)
    if "error" in reply or reply.get("value") != {"values": values}:
        raise StepError("Real host business values differ from the restore scenario")


def check_core_snapshots(path, work):
    """Check the archive has actual paired SQLite stores, without reading keys."""
    with zipfile.ZipFile(path) as archive:
        for name in ("vault", "mfa"):
            payload = archive.read(f"databases/{name}.db")
            destination = work / f"restore-original-{name}.sqlite"
            destination.write_bytes(payload)
            with closing(sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True)) as db:
                if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise StepError("Restore archive lost a valid Vault/MFA SQLite snapshot")
                if name == "mfa":
                    accounts = db.execute("SELECT issuer, kind, counter, length(secret_ct) FROM mfa_accounts").fetchall()
                    if len(accounts) != 1 or accounts[0][:3] != ("QA Module Restore", "hotp", 0) or accounts[0][3] < 16:
                        raise StepError("Restore archive lacks the original encrypted HOTP account")


def stage(ctx, path, *, reject):
    # This is the only non-plugin IPC this oracle can issue. Its path comes
    # from the independently checked exact UI-started job, never from YAML.
    slot = json.dumps("__qaModuleRestore_" + uuid.uuid4().hex)
    args = {"path": str(path), "password": None,
            "vaultPassword": MASTER_PASSWORD if reject else CHANGED_PASSWORD}
    ctx.session.execute(
        f"window[{slot}]={{done:false}};"
        "window.__TAURI_INTERNALS__.invoke('backup_stage_restore'," + json.dumps(args) + ").then("
        f"value=>window[{slot}]={{done:true,value}},"
        f"error=>window[{slot}]={{done:true,error:String(error)}});return true;"
    )
    end = time.monotonic() + 45
    try:
        while time.monotonic() < end:
            envelope = ctx.session.execute(f"return {{observation:window[{slot}]||null}};")
            result = envelope.get("observation") if isinstance(envelope, dict) else None
            if isinstance(result, dict) and result.get("done"):
                if reject:
                    if "VAULT_BAD_PASSWORD" not in result.get("error", ""):
                        raise StepError("Restore did not reject the old current-profile password")
                elif result.get("value", {}).get("restartRequired") is not True or "error" in result:
                    raise StepError("Production restore staging failed")
                return result
            time.sleep(.05)
        raise StepError("Production restore staging timed out")
    finally:
        ctx.session.execute(f"delete window[{slot}];return true;")


def check_staging(profile, state, path):
    if generation(profile) != state["generation"]:
        raise StepError("Staging changed generation before normal shutdown")
    if hashlib.sha256(path.read_bytes()).hexdigest() != state["archiveSha256"]:
        raise StepError("Original archive changed before restore")
    intent_path = profile / "restore_intent.json"
    ordinary(intent_path)
    intent = json.loads(intent_path.read_text(encoding="utf-8"))
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    if intent.get("manifest") != manifest or (profile / "restore_journal.json").exists():
        raise StepError("Staged intent differs from the original archive or apply ran early")
    for entry in manifest["files"]:
        staged = profile / ".pending_restore" / entry["path"]
        ordinary(staged)
        if staged.stat().st_size != entry["sizeBytes"] or hashlib.sha256(staged.read_bytes()).hexdigest() != entry["sha256"]:
            raise StepError("Staged bytes differ from the verified archive")


def run(ctx, args):
    phase = validate(args)
    work = Path(ctx.case_dir).resolve(strict=True)
    fixture = json.loads((work / "official-module-fixture.json").read_text(encoding="utf-8"))
    root = Path(fixture["pluginRoot"])
    if root.resolve(strict=True) != root or not root.is_relative_to(work.parent):
        raise StepError("Restore observation escaped the run-owned profile")
    profile, data = root.parent, root / "hello-plugin/data/hello.sqlite"
    current = generation(profile)
    state_path = work / "module-restore-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
    observed = {"phase": phase, "passed": False}
    try:
        native_record = record(ctx)
        native_state = native_record.get("state")
        if phase == "write-original":
            if state is not None or native_state != "enabled":
                raise StepError("Original restore input requires a fresh enabled signed host")
            require_clean(profile)
            business(ctx, "hello/write", VALUES[:1])
            state = {"generation": current, "step": "original"}
        else:
            if state is None:
                raise StepError("Restore observation requires its original business input")
            if phase in ARCHIVE_STATES:
                expected = ARCHIVE_STATES[phase]
                if state["step"] != "original" or native_state != expected or current != state["generation"]:
                    raise StepError("Module lifecycle or generation differs from the selected backup state")
                require_clean(profile)
                job_id, job = wait_manual_job(ctx, profile, set())
                path = Path(job.get("localPath") or "")
                ordinary(path)
                if not path.is_relative_to(profile):
                    raise StepError("Restore archive escaped the run-owned profile")
                result = check_archive(path, work, current, VALUES[:1])
                check_core_snapshots(path, work)
                state.update(step="archived", registryState=expected, archive=str(path),
                             archiveSha256=result["sha256"], jobId=job_id)
                observed["writerLease"] = writer_lease(root, enabled=expected == "enabled")
            elif phase == "write-mutated":
                if state["step"] != "archived" or native_state != "enabled":
                    raise StepError("Mutation requires the original archive and normally enabled host")
                business(ctx, "hello/write", VALUES)
                state["step"] = "mutated"
            elif phase in {"reject-password", "stage"}:
                if state["step"] != "mutated" or native_state != state["registryState"] or rows(data) != VALUES:
                    raise StepError("Restore must start from changed business data in the same lifecycle state")
                if phase == "stage" and not state.get("passwordRejected"):
                    raise StepError("Restore acceptance requires the current-password rejection check")
                require_clean(profile)
                path = Path(state["archive"])
                if hashlib.sha256(path.read_bytes()).hexdigest() != state["archiveSha256"]:
                    raise StepError("Restore no longer refers to the original verified archive")
                state["activePointerSha256"] = hashlib.sha256((root / "hello-plugin/active.json").read_bytes()).hexdigest()
                stage(ctx, path, reject=phase == "reject-password")
                if rows(data) != VALUES or generation(profile) != state["generation"]:
                    raise StepError("Staging applied business data before normal restart")
                if phase == "reject-password":
                    require_clean(profile)
                    state["passwordRejected"] = True
                else:
                    check_staging(profile, state, path)
                    state["step"] = "staged"
            elif phase == "staged":
                if state["step"] != "staged" or native_state != state["registryState"] or rows(data) != VALUES:
                    raise StepError("Independent staged observation found early apply or changed lifecycle")
                check_staging(profile, state, Path(state["archive"]))
            elif phase == "ui-ready":
                if state["step"] != "mutated" or native_state != state["registryState"] or rows(data) != VALUES:
                    raise StepError("UI restore requires unchanged mutated data and original module lifecycle")
                require_clean(profile)
                if not state.get("passwordRejected") or current != state["generation"]:
                    raise StepError("UI restore requires rejected old credentials and unchanged generation")
                if hashlib.sha256(Path(state["archive"]).read_bytes()).hexdigest() != state["archiveSha256"]:
                    raise StepError("UI restore archive changed after independent verification")
                state["activePointerSha256"] = hashlib.sha256((root / "hello-plugin/active.json").read_bytes()).hexdigest()
                state["step"] = "ui-prepared"
            elif phase in {"restored", "restart-persisted", "ui-restored"}:
                expected_step = {"restored": "staged", "restart-persisted": "restored", "ui-restored": "ui-prepared"}[phase]
                if state["step"] != expected_step:
                    raise StepError("Restore restart observations were requested out of sequence")
                if phase == "ui-restored":
                    relaunch = getattr(ctx.session, "restore_relaunch_observation", {})
                    if relaunch.get("passed") is not True or relaunch.get("manual_launch") is not False:
                        raise StepError("UI restore requires its actually observed automatic relaunch")
                require_clean(profile)
                check_generation(state, current, persisted=phase == "restart-persisted")
                if native_state != state["registryState"] or rows(data) != VALUES[:1]:
                    raise StepError("Applied restore lost original rows or changed module activation state")
                if hashlib.sha256((root / "hello-plugin/active.json").read_bytes()).hexdigest() != state["activePointerSha256"]:
                    raise StepError("Data restore changed the active code pointer")
                if phase == "ui-restored" and native_state == "uninstalled":
                    observed["retainedData"] = check_retained_sqlite(
                        root, Path(state["archive"]), state["archiveSha256"], native_record)
                if native_state == "enabled":
                    business(ctx, "hello/read", VALUES[:1])
                observed["writerLease"] = writer_lease(root, enabled=native_state == "enabled")
                state.update(step="restored", restoredGeneration=current)
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        if state.get("jobId"):
            owner = getattr(ctx, "fixture_context", None) or ctx
            owner.values["module_restore_job_id"] = state["jobId"]
        observed.update(passed=True, generation=current, registryState=native_state)
        return "module restore " + phase + " verified"
    finally:
        with (work / "module-restore-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observed) + "\n")
