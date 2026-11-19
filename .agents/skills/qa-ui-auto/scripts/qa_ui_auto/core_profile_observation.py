"""Observe real bootstrap metadata after app readiness; never create it."""
import json
from pathlib import Path

from .fixtures.backup_policy import isolated_data_root
from .fixtures.core_profile_state import read_generation
from .legacy_process import headless_command, observe_same_profile_contender
from .steps import StepError


def run(ctx, args):
    if (not isinstance(args, dict) or set(args) != {"phase", "path"}
            or args.get("phase") not in {"capture", "unchanged"}
            or not isinstance(args.get("path"), str) or not args["path"]):
        raise StepError("assert_core_profile_generation: expected phase and owned metadata path")
    phase, path = args["phase"], Path(args["path"])
    case = Path(ctx.case_dir).resolve()
    if (path.name != ".profile-state.json" or path.resolve() != path
            or not path.is_relative_to(case.parent) or path.is_relative_to(case)):
        raise StepError("Core profile observation escaped the run-owned profile")
    observation = {"phase": phase, "path": str(path), "passed": False}
    try:
        generation = read_generation(path)
        observation["generation"] = generation
        baseline = getattr(ctx, "_core_profile_baseline", None)
        if phase == "capture":
            if baseline is not None:
                raise StepError("Core generation baseline already captured; recapture would hide a restart change")
            ctx._core_profile_baseline = (path, generation)
        elif baseline != (path, generation):
            raise StepError("Core profile generation changed after normal restart or has no pre-restart baseline")
        observation["passed"] = True
        return "real core profile generation " + ("captured" if phase == "capture" else "unchanged")
    finally:
        with (case / "core-profile-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")


def assert_headless_profile_blocked(ctx, args):
    owner = ctx.fixture_context
    if args is not None or getattr(owner, "case_id", None) != "TC-MODULES-009":
        raise StepError("assert_headless_profile_blocked requires its registered native restart case")
    profile = isolated_data_root(owner)
    generation = read_generation(profile / ".profile-state.json")
    application = ctx.session.application.resolve(strict=True)
    log_dir = Path(ctx.case_dir)

    def desktop_alive():
        ctx.session.wait_for_app_ready(timeout=5)
        return True

    result = observe_same_profile_contender(
        headless_command(application, profile), desktop_alive, log_dir, "desktop-mode-lease",
    )
    passed = result == {
        "exitCode": 1, "modeLeaseError": True, "openedEndpoint": False, "ownerStillRunning": True,
    }
    (log_dir / "desktop-mode-lease.json").write_text(json.dumps({
        "application": str(application), "profile": str(profile), "generation": generation,
        "passed": passed, **result,
    }, indent=2) + "\n", encoding="utf-8")
    if not passed:
        raise StepError("The active desktop must reject headless on the same profile before opening an endpoint")
    return "headless startup exited with the profile-in-use error and the desktop is still ready"
