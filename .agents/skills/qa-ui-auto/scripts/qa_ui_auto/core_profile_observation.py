"""Observe real bootstrap metadata after app readiness; never create it."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from .fixtures.backup_policy import isolated_data_root
from .fixtures.core_profile_state import read_generation
from .legacy_process import MODE_LEASE_DENIAL, headless_command, initialize_profile, observe_same_profile_contender
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
    passed = result == MODE_LEASE_DENIAL
    (log_dir / "desktop-mode-lease.json").write_text(json.dumps({
        "application": str(application), "profile": str(profile), "generation": generation,
        "passed": passed, **result,
    }, indent=2) + "\n", encoding="utf-8")
    if not passed:
        raise StepError("The active desktop must reject headless on the same profile before opening an endpoint")
    return "headless startup exited with the profile-in-use error and the desktop is still ready"


def assert_desktop_profile_blocked(ctx):
    profile = isolated_data_root(ctx.fixture_context)
    generation = read_generation(profile / ".profile-state.json")
    application = ctx.session.application.resolve(strict=True)
    log_dir = Path(ctx.case_dir)
    receipt = {"application": str(application), "profile": str(profile),
               "generation": generation, "passed": False}

    def try_desktop(owner):
        desktop_env = {**os.environ, "NEWMOB_DATA_DIR": str(profile)}
        result = observe_same_profile_contender(
            [str(application)], lambda: owner.poll() is None, log_dir,
            "headless-mode-lease", desktop_env=desktop_env,
        )
        receipt["desktopContender"] = result
        if result != MODE_LEASE_DENIAL:
            raise StepError("The active headless process must reject the desktop with exit code 1 on the same profile")

    try:
        with TemporaryDirectory(prefix="taomni-headless-lease-") as work:
            receipt["headlessOwner"] = initialize_profile(
                application, profile, Path(work), log_dir, "headless-mode-lease", observe_ready=try_desktop,
            )
        if read_generation(profile / ".profile-state.json") != generation:
            raise StepError("The headless process changed the canonical profile generation")
        receipt["passed"] = True
    finally:
        (log_dir / "headless-mode-lease.json").write_text(
            json.dumps(receipt, indent=2) + "\n", encoding="utf-8",
        )
