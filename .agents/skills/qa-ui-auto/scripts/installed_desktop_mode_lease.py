"""Observe both mode conflicts through the installed desktop executable."""

import os
from pathlib import Path
import platform
import subprocess
import time

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.core_profile_state import read_generation
from qa_ui_auto.legacy_process import MODE_LEASE_DENIAL, headless_command, initialize_profile, observe_same_profile_contender


def reserve_default_profile(evidence):
    """Use the production identifier on a fresh hosted runner."""
    system = platform.system()
    if (system not in {"Windows", "Darwin"} or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni"):
        raise RuntimeError("The installed desktop profile requires its disposable hosted runner")

    if system == "Windows":
        directory = subprocess.check_output([
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            "[Environment]::GetFolderPath('ApplicationData')",
        ], text=True, timeout=30).strip()
        root = Path(directory)
    else:
        root = Path.home() / "Library" / "Application Support"
    if not root.is_absolute():
        raise RuntimeError("The production data home could not be resolved")
    profile = root.resolve(strict=True) / "com.taomni.app"
    profile.mkdir()
    write_json(evidence / "owned-default-profile.json", {"path": str(profile), "platform": system})
    return profile


def wait_for_generation(owner, profile):
    state = profile / ".profile-state.json"
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if owner.poll() is not None:
            raise RuntimeError(f"The installed desktop exited during profile setup ({owner.returncode})")
        if state.is_file():
            return read_generation(state)
        time.sleep(0.05)
    raise RuntimeError("The installed desktop did not initialize the fresh production profile")


def observe_desktop_owner(executable, profile, evidence, owner):
    generation = read_generation(profile / ".profile-state.json")
    contender = observe_same_profile_contender(
        headless_command(executable, profile), lambda: owner.poll() is None,
        evidence, "installed-headless-contender",
    )
    if contender != MODE_LEASE_DENIAL:
        raise RuntimeError("The installed desktop did not reject a headless contender")
    return {
        "profile": str(profile), "desktopOwnerPid": owner.pid, "generation": generation,
        "headlessContender": contender,
    }


def verify_headless_owner(executable, work, evidence, observation):
    profile = Path(observation["profile"])

    def check_desktop_conflict(headless):
        contender = observe_same_profile_contender(
            [str(executable)], lambda: headless.poll() is None, evidence,
            "installed-desktop-contender", desktop_env=os.environ.copy(),
        )
        observation["desktopContender"] = contender
        if contender != MODE_LEASE_DENIAL:
            raise RuntimeError("The installed desktop did not report a mode conflict and exit with status 1")

    observation["headlessOwner"] = initialize_profile(
        executable, profile, work, evidence, "installed-headless-owner", observe_ready=check_desktop_conflict,
    )
    if read_generation(profile / ".profile-state.json") != observation["generation"]:
        raise RuntimeError("The installed application changed the production profile generation")
    observation["passed"] = True


def finish_first_release_mode_lease(executable, work, evidence, desktop):
    observation = {
        **desktop, "passed": False, "installedBinary": str(executable), "binarySha256": digest(executable),
    }
    try:
        verify_headless_owner(executable, work, evidence, observation)
        return observation
    finally:
        write_json(evidence / "installed-desktop-mode-lease.json", observation)


def check_mode_lease(executable, work, evidence, *, profile=None):
    observation = {"passed": False, "installedBinary": str(executable), "binarySha256": digest(executable)}
    try:
        if profile is None:
            profile = reserve_default_profile(evidence)
        observation["profile"] = str(profile)
        with (evidence / "installed-desktop-owner.log").open("xb") as output, subprocess.Popen(
            [str(executable)], stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
        ) as desktop:
            try:
                wait_for_generation(desktop, profile)
                observation.update(observe_desktop_owner(executable, profile, evidence, desktop))
            finally:
                if desktop.poll() is None:
                    desktop.kill()
                    observation["desktopOwnerExitCode"] = desktop.wait(timeout=15)

        verify_headless_owner(executable, work, evidence, observation)
        return observation
    finally:
        write_json(evidence / "installed-desktop-mode-lease.json", observation)
