"""Observe native bootstrap metadata and exercise ownership of a QA profile."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from .fixtures.backup_policy import isolated_data_root
from .fixtures.core_profile_state import read_generation
from .legacy_process import MODE_LEASE_DENIAL, headless_command, initialize_profile, observe_same_profile_contender
from .mfa_relaunch_owner import observe_foreign_executable
from .steps import StepError

MFA_RECOVERY_DENIAL = {**MODE_LEASE_DENIAL, "recoveryRecordPreserved": True}


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

    command = headless_command(application, profile)
    result = observe_same_profile_contender(
        command, desktop_alive, log_dir, "desktop-mode-lease",
    )
    recovery = _observe_pending_mfa_contender(
        profile, command, desktop_alive, log_dir, "desktop-mode-lease-pending-mfa",
    )
    guard = observe_foreign_executable(application, profile, log_dir)
    guard["ownerStillRunning"] = desktop_alive()
    denied = result == MODE_LEASE_DENIAL and recovery == MFA_RECOVERY_DENIAL
    passed = denied and guard["rejected"]
    (log_dir / "desktop-mode-lease.json").write_text(json.dumps({
        "application": str(application), "profile": str(profile), "generation": generation,
        "passed": passed, **result, "pendingMfaRecoveryContender": recovery,
        "mfaRelaunchExecutableGuard": guard,
    }, indent=2) + "\n", encoding="utf-8")
    if not denied:
        raise StepError("The active desktop must reject headless on the same profile before opening an endpoint")
    if not guard["rejected"]:
        raise StepError("The MFA upgrade helper accepted a different executable")
    return "the active desktop rejects headless startup and the MFA upgrade helper rejects another executable"


def assert_desktop_profile_blocked(ctx):
    profile = isolated_data_root(ctx.fixture_context)
    generation = read_generation(profile / ".profile-state.json")
    application = ctx.session.application.resolve(strict=True)
    log_dir = Path(ctx.case_dir)
    receipt = {"application": str(application), "profile": str(profile),
               "generation": generation, "passed": False}

    def try_desktop(owner):
        desktop_env = {**os.environ, "NEWMOB_DATA_DIR": str(profile)}
        def owner_alive():
            return owner.poll() is None

        result = observe_same_profile_contender(
            [str(application)], owner_alive, log_dir,
            "headless-mode-lease", desktop_env=desktop_env,
        )
        receipt["desktopContender"] = result
        if result != MODE_LEASE_DENIAL:
            raise StepError("The active headless process must reject the desktop with exit code 1 on the same profile")
        recovery = _observe_pending_mfa_contender(
            profile, [str(application)], owner_alive, log_dir,
            "headless-mode-lease-pending-mfa", desktop_env=desktop_env,
        )
        receipt["pendingMfaRecoveryContender"] = recovery
        if recovery != MFA_RECOVERY_DENIAL:
            raise StepError("The active headless process must reject the desktop and preserve the MFA recovery record")

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


def _observe_pending_mfa_contender(profile, command, owner_alive, evidence, label, *, desktop_env=None):
    directory = profile / "migration"
    if directory.resolve() != directory:
        raise StepError("MFA recovery record must stay within the run-owned profile")
    directory.mkdir(exist_ok=True)
    marker = directory / "mfa-transaction.json"
    # The contender must recognize the live owner before reading this sentinel.
    contents = b"{}\n"
    with marker.open("xb") as stream:
        stream.write(contents)
    try:
        result = observe_same_profile_contender(
            command, owner_alive, evidence, label, desktop_env=desktop_env,
        )
        return {**result, "recoveryRecordPreserved": marker.is_file()
                and not marker.is_symlink() and marker.read_bytes() == contents}
    finally:
        marker.unlink(missing_ok=True)
