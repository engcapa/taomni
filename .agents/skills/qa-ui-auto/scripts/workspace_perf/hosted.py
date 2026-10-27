"""Prepare matched release runtimes only after a successful hosted full suite."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from qa_ui_auto.ci import selection_entry
from qa_ui_auto.provenance import execution_identity

EXTERNAL_CASE = "TC-IDE-C6-06-java-definition-realproject-native"


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def validate_gate(run, selection, summary, head, identity):
    if (
        run.get("head_sha") != head
        or run.get("conclusion") != "success"
        or run.get("path") != ".github/workflows/qa-ui-auto-platforms.yml"
    ):
        raise ValueError(
            "A successful qa-ui-auto-platforms run for this commit is required"
        )
    if (
        selection.get("scope") != "all"
        or selection.get("head") != head
        or selection.get("identity") != identity
        or summary.get("head") != head
        or str(selection.get("run_id")) != str(run["id"])
        or str(summary.get("run_id")) != str(run["id"])
    ):
        raise ValueError("Full-suite source, runner and invocation must match")
    if (
        summary.get("passed") is not True
        or summary.get("report_ok") is not True
        or summary.get("failures")
        or summary.get("infrastructure_errors")
        or not summary.get("job_results")
        or any(
            value not in {"success", "skipped"}
            for value in summary["job_results"].values()
        )
    ):
        raise ValueError("Functional cases and supporting jobs must all pass")
    groups = summary.get("groups", [])
    required = {
        f"{platform}-{mode}"
        for platform in ("linux", "windows", "macos")
        for mode in ("browser", "native")
    }
    if not required <= {group["id"] for group in groups}:
        raise ValueError("All three browser/native platform groups are required")
    for group in groups:
        if (
            group.get("errors")
            or not group.get("selected")
            or group.get("counts") != {"passed": group["selected"]}
        ):
            raise ValueError("Missing or nonpassing functional execution cells")
    for gap in selection.get("gaps", []):
        if (
            gap.get("case") != EXTERNAL_CASE
            or gap.get("mode") != "native"
            or gap.get("platform") not in {"linux", "windows", "macos"}
        ):
            raise ValueError("Unexpected external capability gap")


def download_one(run_id, artifacts, prefix, destination):
    found = [
        artifact
        for artifact in artifacts
        if artifact["name"].startswith(prefix) and not artifact.get("expired")
    ]
    if len(found) != 1:
        raise ValueError(f"Expected one {prefix} artifact, found {len(found)}")
    destination.mkdir(parents=True, exist_ok=False)
    gh(
        "run",
        "download",
        str(run_id),
        "--name",
        found[0]["name"],
        "--dir",
        str(destination),
    )


def linux_release_entry(selection):
    builds = {build["id"]: build for build in selection["builds"]}
    for entry in selection["entries"]:
        build = builds.get(entry.get("build_id"), {})
        if (
            entry["platform_key"] == "linux"
            and entry["mode"] == "native"
            and "release" in entry["capabilities"]
            and build.get("runner") == "ubuntu-22.04"
            and build.get("profile") == "release"
        ):
            return entry
    raise ValueError("The passing suite must export an Ubuntu 22.04 release runtime")


def prepare(args):
    repo = Path.cwd().resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", args.baseline):
        raise ValueError("Baseline must be an immutable commit SHA")
    subprocess.run(
        ["git", "merge-base", "--is-ancestor", args.baseline, head], check=True
    )
    repository = os.environ["GITHUB_REPOSITORY"]
    run = json.loads(
        gh("api", f"repos/{repository}/actions/runs/{args.functional_run}")
    )
    artifacts = []
    for page in range(1, 100):
        response = json.loads(
            gh(
                "api",
                f"repos/{repository}/actions/runs/{args.functional_run}/artifacts?per_page=100&page={page}",
            )
        )
        artifacts.extend(response["artifacts"])
        if len(response["artifacts"]) < 100:
            break
    download_one(args.functional_run, artifacts, "qa-selection-", out / "selection")
    download_one(args.functional_run, artifacts, "qa-summary-", out / "summary")
    selection_path = out / "selection/selection.json"
    selection = json.loads(selection_path.read_text())
    summary = json.loads((out / "summary/ci-summary.json").read_text())
    validate_gate(run, selection, summary, head, execution_identity(repo))
    entry = linux_release_entry(selection)
    # This also binds every selected YAML digest, using the existing CI contract.
    selection_entry(selection_path, entry["id"])
    download_one(
        args.functional_run, artifacts, f"runtime-{entry['build_id']}-", out / "runtime"
    )
    baseline = Path(os.environ["RUNNER_TEMP"]) / "workspace-perf-main"
    subprocess.run(
        ["git", "worktree", "add", "--detach", str(baseline), args.baseline], check=True
    )
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=baseline, check=True)
    shared_target = repo / "src-tauri/target/qa-ui-auto"
    shared_target.mkdir(parents=True, exist_ok=True)
    baseline_target = baseline / "src-tauri/target/qa-ui-auto"
    baseline_target.parent.mkdir(parents=True, exist_ok=True)
    baseline_target.symlink_to(shared_target, target_is_directory=True)
    subprocess.run(
        [
            sys.executable,
            str(Path(__file__).with_name("build_baseline.py")),
            "--checkout", str(baseline),
        ],
        cwd=baseline,
        env=dict(os.environ, PYTHONPATH=str(repo / ".agents/skills/qa-ui-auto/scripts")),
        check=True,
    )
    # Keep the original baseline binary and identity before restoring the
    # already-tested candidate runtime over the shared Cargo output directory.
    snapshot = baseline_target.parent / "baseline-runtime"
    excluded = {"deps", "build", "incremental", ".fingerprint", "examples", "bundle"}
    shutil.copytree(
        baseline_target / "release",
        snapshot / "release",
        ignore=lambda directory, names: [
            name
            for name in names
            if name in excluded
            or name.startswith(".")
            or Path(name).suffix in {".d", ".rlib", ".a", ".lib", ".pdb", ".exp"}
        ],
    )
    baseline_target.unlink()
    snapshot.rename(baseline_target)
    from ci_native_artifact import install

    install(out / "runtime/runtime.tar.gz", selection, entry)
    plan = {
        "baseline": args.baseline,
        "candidate": head,
        "functionalRun": args.functional_run,
        "order": ["main-1", "candidate-1", "main-2", "candidate-2"],
        "build": "Original release QA identities, source digests and binary bytes checked before every launch",
        "limits": [
            "QA terminal full-buffer mirroring is enabled in both builds; output is not production mirror-off throughput",
            "DOM and next-frame timing is not physical key-to-screen latency",
            "Ubuntu/WebKitGTK/Xvfb does not establish Windows/macOS/GPU performance",
        ],
        "environment": {
            "cpuCount": os.cpu_count(),
            "platform": sys.platform,
            "osRelease": Path("/etc/os-release").read_text(),
            "webkit": subprocess.check_output(
                ["pkg-config", "--modversion", "webkit2gtk-4.1"], text=True
            ).strip(),
        },
        "baselineCheckout": str(baseline),
        "candidateCheckout": str(repo),
    }
    (out / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")


def measure(args):
    from ci_desktop import Desktop

    out = args.out.resolve()
    plan = json.loads((out / "plan.json").read_text())
    runner_path = str(Path(__file__).resolve().parents[1])
    with Desktop(out / "desktop", [], "ubuntu-22.04-x11"):
        for label in plan["order"]:
            checkout = (
                plan["baselineCheckout"]
                if label.startswith("main")
                else plan["candidateCheckout"]
            )
            env = dict(os.environ, PYTHONPATH=runner_path)
            command = [
                sys.executable,
                "-m",
                "workspace_perf.probe",
                "--checkout",
                checkout,
                "--out",
                str(out),
                "--label",
                label,
            ]
            with (out / (label + ".log")).open("w") as log:
                subprocess.run(
                    command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True
                )
    subprocess.run(
        [sys.executable, "-m", "workspace_perf.analyze", "--out", str(out)], check=True
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "measure"])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--functional-run", type=int)
    parser.add_argument("--baseline")
    args = parser.parse_args()
    if args.operation == "prepare":
        if not args.functional_run or not args.baseline:
            parser.error("prepare requires --functional-run and --baseline")
        prepare(args)
    else:
        measure(args)


if __name__ == "__main__":
    main()
