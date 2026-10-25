"""Native cold-start persistence boundary, with no fixture or storage reseeding."""
import json

from .native_steps import _verb
from .steps import StepError


@_verb("native_restart_app")
def restart_application(ctx, args):
    if args is not None:
        raise StepError("native_restart_app: no arguments are accepted")
    restart = getattr(ctx.session, "application_restarter", None)
    if not callable(restart):
        raise StepError("native_restart_app: this session has no owned application launcher")
    result = restart()
    with (ctx.case_dir / "native-application-restarts.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(result) + "\n")
    return "restarted the owned QA process with the same isolated profile"
