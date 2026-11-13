"""Native cold-start persistence boundary, with no fixture or storage reseeding."""
import json

from native_application_restart import validate_exit_confirmation

from .native_steps import _verb
from .steps import StepError


@_verb("native_restart_app")
def restart_application(ctx, args):
    expected = None
    if args is not None:
        if not isinstance(args, dict) or set(args) != {"expect_exit_confirmation"}:
            raise StepError("native_restart_app: use null or {expect_exit_confirmation: {title, message, confirm_label}}")
        try:
            expected = validate_exit_confirmation(args["expect_exit_confirmation"])
        except ValueError as error:
            raise StepError(f"native_restart_app: {error}") from error
    restart = getattr(ctx.session, "application_restarter", None)
    if not callable(restart):
        raise StepError("native_restart_app: this session has no owned application launcher")
    try:
        # Keep no-argument launchers/cases compatible; opt-in is never implicit.
        result = restart() if expected is None else restart(expect_exit_confirmation=expected)
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
