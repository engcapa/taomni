"""Fixed real-UI restore confirmation, process observation and bridge attachment."""
import hashlib
import json
import sqlite3
from contextlib import closing

from .steps import StepError

MFA_UPGRADE_ISSUERS = {
    "TC-MODULES-038": "Signed Upgrade",
    "TC-MODULES-044": "Installed MFA Upgrade",
}


def run(ctx, args):
    if args is not None:
        raise StepError("native_confirm_restore_relaunch accepts null only")
    callback = getattr(ctx.session, "restore_relauncher", None)
    if not callable(callback):
        raise StepError("native_confirm_restore_relaunch requires its owned native bridge")
    try:
        callback()
        return "observed the restore confirmation's own native application relaunch"
    except Exception as error:
        result = getattr(ctx.session, "restore_relaunch_observation", {})
        result.update(passed=False, error=str(error))
        ctx.session.restore_relaunch_observation = result
        raise
    finally:
        result = getattr(ctx.session, "restore_relaunch_observation", {"passed": False})
        with (ctx.case_dir / "native-restore-relaunch.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(result) + "\n")


def run_mfa(ctx, args):
    case_id = getattr(ctx.fixture_context, "case_id", None)
    if args is not None or case_id not in MFA_UPGRADE_ISSUERS:
        raise StepError("MFA upgrade relaunch requires its fixed native case")
    callback = getattr(ctx.session, "mfa_upgrade_relauncher", None)
    if not callable(callback):
        raise StepError("MFA upgrade relaunch requires its owned native bridge")
    try:
        before = installed_mfa_state(ctx) if case_id == "TC-MODULES-044" else None
        callback(expected_issuer=MFA_UPGRADE_ISSUERS[case_id])
        if before is not None:
            after = installed_mfa_state(ctx)
            if before["targetPresent"] or not after["targetPresent"] or before["pointerSha256"] != after["pointerSha256"]:
                raise StepError("MFA migration did not retain its preinstalled module pointer and publish its own database")
            if before["legacyRowsSha256"] != after["legacyRowsSha256"]:
                raise StepError("MFA migration changed the original encrypted records")
            ctx.session.mfa_upgrade_relaunch_observation["installedPackage"] = {"before": before, "after": after}
        return "observed the successful native exit and reattached to the restarted application"
    except Exception as error:
        result = getattr(ctx.session, "mfa_upgrade_relaunch_observation", {})
        result.update(passed=False, error=str(error))
        ctx.session.mfa_upgrade_relaunch_observation = result
        raise
    finally:
        result = getattr(ctx.session, "mfa_upgrade_relaunch_observation", {"passed": False})
        (ctx.case_dir / "native-mfa-upgrade-relaunch.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def installed_mfa_state(ctx):
    from .fixtures.module_download import plugin_root

    plugins = plugin_root(ctx)
    pointer = (plugins / "mfa/active.json").read_bytes()
    provenance = json.loads((ctx.case_dir / "signed-mfa/provenance.json").read_text(encoding="utf-8"))
    version = provenance["version"]
    if json.loads(pointer).get("activeVersion") != version:
        raise StepError("Expected the QA signed MFA version to already be installed")
    proof = plugins / "mfa/versions" / version / ".taomni-trust/package.taomni-plugin"
    if hashlib.sha256(proof.read_bytes()).hexdigest() != provenance["sha256"]:
        raise StepError("Installed MFA package differs from its signed input receipt")
    legacy = plugins.parent / "mfa.db"
    with closing(sqlite3.connect(legacy.as_uri() + "?mode=ro", uri=True)) as db:
        # A normal exit may checkpoint the WAL. Compare the encrypted records
        # from the same logical database view, including any committed WAL rows.
        db.execute("BEGIN")
        legacy_rows = hashlib.sha256("\n".join(db.iterdump()).encode()).hexdigest()
    return {
        "pointerSha256": hashlib.sha256(pointer).hexdigest(),
        "legacyRowsSha256": legacy_rows,
        "targetPresent": (plugins / "mfa/data/mfa.db").is_file(),
    }
