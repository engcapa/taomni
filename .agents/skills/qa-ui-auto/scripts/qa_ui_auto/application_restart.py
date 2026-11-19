"""Native cold-start persistence boundary, with no fixture or storage reseeding."""
from functools import partial
import json

from native_application_restart import validate_exit_confirmation

from .native_steps import _verb
from .steps import StepError


@_verb("native_restart_app")
def restart_application(ctx, args):
    expected = None
    preserve_dirty_drafts = False
    verify_mode_lease = False
    if args is not None:
        if (not isinstance(args, dict) or not args
                or not set(args) <= {"expect_exit_confirmation", "preserve_dirty_drafts", "verify_mode_lease"}):
            raise StepError("native_restart_app: expected exit, draft retention or mode lease options")
        if "preserve_dirty_drafts" in args:
            if args["preserve_dirty_drafts"] is not True:
                raise StepError("native_restart_app: preserve_dirty_drafts must be true when present")
            preserve_dirty_drafts = True
        if "verify_mode_lease" in args:
            if args["verify_mode_lease"] is not True or getattr(ctx.fixture_context, "case_id", None) != "TC-MODULES-009":
                raise StepError("native_restart_app: mode lease verification requires TC-MODULES-009")
            verify_mode_lease = True
        if "expect_exit_confirmation" in args:
            try:
                expected = validate_exit_confirmation(args["expect_exit_confirmation"])
            except ValueError as error:
                raise StepError(f"native_restart_app: {error}") from error
    restart = getattr(ctx.session, "application_restarter", None)
    if not callable(restart):
        raise StepError("native_restart_app: this session has no owned application launcher")
    try:
        # Keep no-argument launchers/cases compatible; opt-in is never implicit.
        if expected is None and not preserve_dirty_drafts and not verify_mode_lease:
            result = restart()
        else:
            options = {"expect_exit_confirmation": expected} if expected is not None else {}
            if preserve_dirty_drafts:
                options["preserve_dirty_drafts"] = True
            if verify_mode_lease:
                from .core_profile_observation import assert_desktop_profile_blocked
                options["before_relaunch"] = partial(assert_desktop_profile_blocked, ctx)
            result = restart(**options)
    except Exception as error:
        result = {**getattr(ctx.session, "application_restart_observation", {}),
                  "status": "failed", "error": str(error),
                  "last_request": getattr(ctx.session, "last_request", {})}
        with (ctx.case_dir / "native-application-restarts.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(result) + "\n")
        raise
    with (ctx.case_dir / "native-application-restarts.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(result) + "\n")
    return "restarted the owned QA process with the same isolated profile"
