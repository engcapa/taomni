"""Dispatch the registered Taomni QA workflows and record their run identities."""

import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import quote


UPGRADE = "qa-modular-upgrade.yml"
PLATFORMS = "qa-ui-auto-platforms.yml"
SUITES = {"all", "system", "protocol", "host", "signed", "desktop", "core", "release"}
MACOS_RUNNERS = {"macos-15", "macos-15-intel", "macos-26"}
LINUX_PACKAGE = "linux-x86_64"
DESKTOP_PACKAGES = ("windows-x86_64", "darwin-aarch64", "darwin-x86_64")


def api(repository, endpoint, *, body=None, retry_missing=False):
    command = ["gh", "api", f"repos/{repository}/{endpoint}"]
    if body is not None:
        command.extend(["--method", "POST", "--input", "-"])
    delays = (0, 1, 2, 4, 8, 16) if retry_missing and body is None else (0,)
    for delay in delays:
        if delay:
            time.sleep(delay)
        result = subprocess.run(
            command, input=json.dumps(body) if body is not None else None,
            capture_output=True, encoding="utf-8", timeout=45,
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        if "(HTTP 404)" not in result.stderr:
            break
    raise RuntimeError(f"GitHub API request failed for {endpoint}: {result.stderr.strip()}")


def plan(suite, macos_runner, package_run, package_version, package_targets="all", *,
         first_release=False):
    if suite not in SUITES or macos_runner not in MACOS_RUNNERS:
        raise ValueError("Choose a supported QA suite and macOS runner")
    if first_release and (suite != "release" or not package_run):
        raise ValueError("Select the release suite with a matching first-release bundle run")
    if (package_run or package_version or suite == "release") and (
        not re.fullmatch(r"[1-9][0-9]*", package_run)
        or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", package_version)
    ):
        raise ValueError("Provide both the Release Bundle run ID and its installer version")

    checks = []
    if suite in {"all", "system"}:
        checks.append(("G1/G3 system execution", UPGRADE, {"system_execution_only": "true"}))
    if suite in {"all", "protocol"}:
        checks.append(("G2/G5/G8/G10 capture, throughput, package and RPC contracts", UPGRADE, {
            "protocol_only": "true", "rdp_pipeline": "true",
        }))
    if suite in {"all", "host"}:
        checks.append(("G4/G6/G7/G10/G11 process and profile contracts", UPGRADE, {"host_only": "true"}))
    if suite in {"all", "signed"}:
        checks.append(("G7/G8/G11 signed module installation and migration", UPGRADE, {
            "signed_mfa_only": "true",
        }))
    if suite in {"all", "desktop"}:
        checks.append(("G2/G4/G5/G7/G8/G9/G11 browser and native cases", PLATFORMS, {
            "scope": "selected", "platforms": "linux,windows,macos", "modes": "browser,native",
            "linux_profiles": "ubuntu-24.04-xvfb",
            "macos_runner": macos_runner, "native_release": "true", "features": "F-Modules-1",
            "modular_rdp_p95": "true",
            "case_ids": (
                "TC-MFA-106,TC-MOBILE-003,TC-MOBILE-021,"
                "TC-SHOT-003,TC-SHOT-N2,TC-SHOT-N10,TC-SHOT-N15,TC-SHOT-N19,"
                "TC-RDPS-NAT-01-start-connect-display,TC-RDPS-PERF-01-performance-budget,"
                "TC-MAIL-STORAGE-01,TC-MAIL-STORAGE-02,TC-MAIL-STORAGE-03,TC-MAIL-STORAGE-04,"
                "TC-MAIL-STORAGE-05,TC-MAIL-STORAGE-06,TC-MAIL-STORAGE-07,TC-MAIL-STORAGE-08,"
                "TC-MAIL-STORAGE-09,TC-MAIL-SEND-01,TC-MAIL-OUTBOX-01,TC-MAIL-ATTACH-01,TC-MAIL-FOLDER-01"
            ),
        }))
        checks.append(("G2/G5 Linux Wayland native capture and input", PLATFORMS, {
            "scope": "selected", "platforms": "linux", "modes": "native",
            "linux_profiles": "ubuntu-26.04-wayland", "native_release": "true",
            "modular_rdp_p95": "true",
            "case_ids": (
                "TC-MFA-106,TC-SHOT-N2,TC-SHOT-N10,"
                "TC-RDPS-NAT-01-start-connect-display,TC-RDPS-PERF-01-performance-budget"
            ),
        }))
    if suite in {"all", "release"} and package_run:
        supported = (LINUX_PACKAGE, *DESKTOP_PACKAGES)
        targets = supported if package_targets == "all" else tuple(
            target.strip() for target in package_targets.split(",")
        )
        if len(targets) != len(set(targets)) or any(target not in supported for target in targets):
            raise ValueError("Select all or unique supported release package targets")
        package = {"package_run": package_run, "package_version": package_version}
        arm_runner = "macos-26" if macos_runner == "macos-26" else "macos-15"
        if LINUX_PACKAGE in targets:
            linux = {**package, "package_targets": LINUX_PACKAGE}
            installed = {**linux, "package_relocation_linux": "true", "package_rdp_perf": "true"}
            if first_release:
                installed["package_first_release_linux"] = "true"
            checks.extend([
                ("G9 Linux release bundle inspection", UPGRADE, linux),
                ("G4/G5/G6/G11 installed Linux recovery, RDP, forced exit and profile leases",
                 UPGRADE, installed),
            ])
        desktop = [target for target in targets if target in DESKTOP_PACKAGES]
        if desktop:
            upgrade = "package_first_release_desktop" if first_release else "package_upgrade_desktop"
            checks.append(("G1/G3/G9/G11 MSI/DMG inspection, upgrade and rollback", UPGRADE, {
                **package, upgrade: "true", "package_macos_arm_runner": arm_runner,
                "package_targets": ",".join(desktop),
            }))
    return checks


def dispatch(repository, source_ref, expected_head, suite, macos_runner, package_run, package_version,
             package_targets="all", *, first_release=False):
    checks = plan(suite, macos_runner, package_run, package_version, package_targets,
                  first_release=first_release)
    subprocess.run(["git", "check-ref-format", f"refs/heads/{source_ref}"], check=True)
    branch = api(repository, f"git/ref/heads/{quote(source_ref, safe='/')}")
    head = branch.get("object", {}).get("sha", "")
    if branch.get("ref") != f"refs/heads/{source_ref}" or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("Could not resolve a repository branch to its full SHA")
    if expected_head and expected_head != head:
        raise ValueError(f"Expected the full SHA at the tip of {source_ref}, currently {head}")
    if suite in {"all", "release"} and package_run:
        producer = api(repository, f"actions/runs/{package_run}")
        if (producer.get("head_sha"), producer.get("path"), producer.get("event")) != (
            head, ".github/workflows/release.yml", "workflow_dispatch",
        ):
            raise ValueError("Select an artifact-only Release Bundle run for the pinned source")
        if first_release:
            roster = f"modular-candidate-roster-{package_run}"
            artifacts = api(repository, f"actions/runs/{package_run}/artifacts?name={roster}")
            if sum(row["name"] == roster and not row["expired"] for row in artifacts["artifacts"]) != 1:
                raise ValueError(f"Expected one available signed roster artifact {roster}")

    receipt = {"sourceRef": source_ref, "sourceSha": head, "suite": suite,
               "firstRelease": first_release, "runs": []}
    summary = [f"## Modular QA for `{head}`", ""]
    try:
        for name, workflow, inputs in checks:
            inputs = {"head": head, **inputs}
            if "package_run" in inputs:
                inputs["package_source"] = head
            response = api(repository, f"actions/workflows/{workflow}/dispatches", body={
                "ref": source_ref, "inputs": inputs, "return_run_details": True,
            })
            run_id = response["workflow_run_id"]
            url = f"https://github.com/{repository}/actions/runs/{run_id}"
            run = {"check": name, "workflow": workflow, "id": run_id, "url": url, "inputs": inputs}
            receipt["runs"].append(run)
            print(f"{name} {url}", flush=True)
            # A workflow dispatch can return a run ID before the run is readable.
            recorded = api(repository, f"actions/runs/{run_id}", retry_missing=True)
            run["workflowSha"] = recorded.get("head_sha")
            if run["workflowSha"] != head:
                raise ValueError(f"Workflow ref moved during dispatch. Run {run_id} has a different workflow SHA")
            summary.append(f"- [{name}]({url})")
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as outputs:
            outputs.write(f"head={head}\n")
    finally:
        Path("modular-gate-runs.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        if suite == "all" and not package_run:
            summary.extend(["", "Release bundle inspection and installed-package checks await a matching Release Bundle run."])
        summary.extend(["", "Read the linked runs for conclusions and per-platform receipts. "
                        "System trust, desktop permission ownership and core-only release closure require their corresponding release evidence."])
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as report:
            report.write("\n".join(summary) + "\n")


if __name__ == "__main__":
    dispatch(
        os.environ["GITHUB_REPOSITORY"], os.environ["SOURCE_REF"], os.environ["EXPECTED_HEAD"],
        os.environ["VERIFICATION_SUITE"], os.environ["MACOS_RUNNER"],
        os.environ["PACKAGE_RUN"], os.environ["PACKAGE_VERSION"],
        os.environ.get("PACKAGE_TARGETS") or "all",
        first_release=os.environ.get("FIRST_RELEASE") == "true",
    )
