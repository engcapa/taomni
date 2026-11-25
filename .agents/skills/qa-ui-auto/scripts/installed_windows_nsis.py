"""Check the default Windows updater installer against an existing monolithic installation."""
from dataclasses import asdict
import json
import os
from pathlib import Path
import platform
import subprocess

from modular_bundle_inventory import digest, inventory, write_json
from qa_ui_auto import legacy_baseline
from qa_ui_auto.fixtures.module_legacy_install import insert_business_rows, session_rows
from qa_ui_auto.fixtures.module_upgrade import input_sessions
from qa_ui_auto.legacy_install import command
from qa_ui_auto.legacy_process import initialize_profile
from qa_ui_auto.legacy_release import ReleaseAsset, download_asset

VOICE_DLLS = ("sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll",
             "onnxruntime_providers_shared.dll")


def nsis_asset(release, baseline):
    if legacy_baseline.freeze(release, baseline["version"]) != baseline:
        raise ValueError("The public monolith changed after the installer baseline was selected")
    name = f"Taomni_{baseline['version']}_x64-setup.exe"
    return ReleaseAsset(**legacy_baseline.asset_identity(release["assets"], name))


def install(installer, slot, report, phase):
    # NSIS expects /D as the last, unquoted argument, even for paths containing spaces.
    args = [str(installer), "/S"] if phase == "original" else [str(installer), "/P", "/UPDATE"]
    command(subprocess.list2cmdline(args) + " /D=" + str(slot), report, phase + "-installer")
    executable = slot / "taomni.exe"
    return {"installerSha256": digest(installer), "binarySha256": digest(executable),
            "voiceDlls": {name: digest(slot / name) for name in VOICE_DLLS if (slot / name).is_file()}}


def run():
    if (platform.system() != "Windows" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
            or os.environ.get("GITHUB_REPOSITORY") != legacy_baseline.REPOSITORY):
        raise RuntimeError("NSIS installation requires a disposable hosted Windows runner")
    report = Path("bundle-evidence").resolve()
    identity = json.loads((report / "bundle-source.json").read_bytes())
    if identity["target"] != "windows-x86_64":
        raise RuntimeError("Expected a Windows x64 release bundle")
    directory = Path("package-input").resolve()
    payload = inventory(directory, identity)
    setup, = [f for f in payload["files"] if f["name"].endswith("-setup.exe")]
    candidate = directory / setup["name"]
    msi = json.loads((report / "windows-payload.json").read_text(encoding="utf-8-sig"))
    baseline = legacy_baseline.current()
    old = nsis_asset(legacy_baseline.metadata("/tags/" + baseline["tag"]), baseline)
    work = Path("nsis-upgrade-work").resolve()
    work.mkdir()
    slot = work / "application"
    profile = work / "profile"
    profile.mkdir()
    download_asset(work, old, token=os.environ.pop("GH_TOKEN"))
    result = {"passed": False, "producer": identity, "legacyReleaseId": baseline["releaseId"],
              "legacyAsset": asdict(old), "runner": json.loads((report / "runner.json").read_bytes()),
              "stages": {}}
    stages = result["stages"]
    expected_rows = None
    try:
        for phase, package in (("original", work / old.name), ("upgrade", candidate), ("rollback", work / old.name)):
            stage = stages[phase] = install(package, slot, report, phase)
            if phase == "upgrade":
                if (stage["binarySha256"] != msi["executableSha256"] or stage["voiceDlls"]
                        or stage["binarySha256"] == stages["original"]["binarySha256"]):
                    raise RuntimeError("NSIS upgrade did not install the modular core and remove old voice DLLs")
            if phase == "rollback" and any(stage[k] != stages["original"][k] for k in ("installerSha256", "binarySha256", "voiceDlls")):
                raise RuntimeError("NSIS rollback did not restore the original executable and runtime DLLs")
            stage["startup"] = initialize_profile(slot / "taomni.exe", profile, work, report, phase)
            if phase == "original":
                insert_business_rows(profile, input_sessions(True))
                expected_rows = session_rows(profile)
            elif session_rows(profile) != expected_rows:
                raise RuntimeError(f"The original sessions changed during NSIS {phase}")
            stage["sessionTypes"] = [row["session_type"] for row in expected_rows]
        result["passed"] = True
    finally:
        write_json(report / "installed-nsis-upgrade.json", result)


if __name__ == "__main__":
    run()
