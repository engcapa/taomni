"""Fixed real-UI restore confirmation, process observation and bridge attachment."""
import json

from .steps import StepError


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
    if args is not None or getattr(ctx.fixture_context, "case_id", None) != "TC-MODULES-038":
        raise StepError("MFA upgrade relaunch requires its fixed native case")
    callback = getattr(ctx.session, "mfa_upgrade_relauncher", None)
    if not callable(callback):
        raise StepError("MFA upgrade relaunch requires its owned native bridge")
    try:
        callback()
        return "observed the successful native exit and reattached to the restarted application"
    except Exception as error:
        result = getattr(ctx.session, "mfa_upgrade_relaunch_observation", {})
        result.update(passed=False, error=str(error))
        ctx.session.mfa_upgrade_relaunch_observation = result
        raise
    finally:
        result = getattr(ctx.session, "mfa_upgrade_relaunch_observation", {"passed": False})
        (ctx.case_dir / "native-mfa-upgrade-relaunch.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
