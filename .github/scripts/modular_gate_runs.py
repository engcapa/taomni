"""Dispatch the registered Taomni QA workflows and record their run identities."""

import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote


UPGRADE = "qa-modular-upgrade.yml"
PLATFORMS = "qa-ui-auto-platforms.yml"
SUITES = {"all", "system", "protocol", "host", "desktop", "core", "release"}
MACOS_RUNNERS = {"macos-15", "macos-15-intel", "macos-26"}


def api(repository, endpoint, *, body=None):
    command = ["gh", "api", f"repos/{repository}/{endpoint}"]
    if body is not None:
        command.extend(["--method", "POST", "--input", "-"])
    output = subprocess.check_output(
        command, input=json.dumps(body) if body is not None else None,
        encoding="utf-8", timeout=45,
    )
    return json.loads(output)


def plan(suite, macos_runner, package_run, package_version):
    if suite not in SUITES or macos_runner not in MACOS_RUNNERS:
        raise ValueError("Choose a supported QA suite and macOS runner")
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
    if suite in {"all", "desktop"}:
        checks.append(("G2/G4/G7/G8/G11 browser and native cases", PLATFORMS, {
            "scope": "selected", "platforms": "linux,windows,macos", "modes": "browser,native",
            "macos_runner": macos_runner, "native_release": "true", "features": "F-Modules-1",
            "case_ids": "TC-MFA-106,TC-MOBILE-021,TC-SHOT-N15",
        }))
    if suite in {"all", "release"} and package_run:
        package = {"package_run": package_run, "package_version": package_version}
        arm_runner = "macos-26" if macos_runner == "macos-26" else "macos-15"
        checks.extend([
            ("G1/G3/G9 release bundle inspection", UPGRADE, {
                **package, "package_targets": "all", "package_macos_arm_runner": arm_runner,
            }),
            ("G4/G5/G6 installed Linux noexec, RDP and forced exit", UPGRADE, {
                **package, "package_relocation_linux": "true", "package_rdp_perf": "true",
            }),
            ("G11 installed MSI/DMG upgrade and rollback", UPGRADE, {
                **package, "package_upgrade_desktop": "true", "package_macos_arm_runner": arm_runner,
            }),
        ])
    return checks


def dispatch(repository, source_ref, expected_head, suite, macos_runner, package_run, package_version):
    checks = plan(suite, macos_runner, package_run, package_version)
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

    receipt = {"sourceRef": source_ref, "sourceSha": head, "suite": suite, "runs": []}
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
            recorded = api(repository, f"actions/runs/{run_id}")
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
    )
