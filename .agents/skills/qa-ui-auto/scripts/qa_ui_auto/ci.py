"""GitHub QA planning and evidence aggregation; execution stays in the QA runner."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import yaml

from .feature_catalog import load_features
from .provenance import execution_identity, input_digest
from .testcase import discover
from .verification import browser_support, native_support, plan as impact_plan

PLATFORMS = {"linux": ("Linux", "ubuntu-24.04", "X64"),
             "windows": ("Windows", "windows-2025", "X64"),
             "macos": ("macOS", "macos-15", "ARM64")}
POLICY = Path("qa-ui-auto-tests/ci/policy.yaml")
DEPENDENCIES = Path("qa-ui-auto-tests/ci/dependencies.yaml")


def csv(value: str) -> list[str]:
    return list(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args]).decode("utf-8").strip()


def commit(ref: str) -> str:
    return git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def selection_digest(manifest: dict) -> str:
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def diff_paths(base: str, head: str) -> tuple[str, list[str]]:
    ancestor = git("merge-base", base, head)
    raw = subprocess.check_output(["git", "diff", "--name-status", "-z", "-M", ancestor, head])
    fields = iter(raw.decode("utf-8").rstrip("\0").split("\0") if raw else [])
    paths = set()
    for status in fields:
        paths.add(next(fields))
        if status.startswith(("R", "C")):
            paths.add(next(fields))
    return ancestor, sorted(paths)


def dependency_order(ids: set[str], dependencies: dict, known: set[str]) -> list[str]:
    ordered, active, done = [], set(), set()

    def visit(case_id):
        if case_id not in known:
            raise ValueError(f"unknown case/dependency: {case_id}")
        if case_id in active:
            raise ValueError(f"case dependency cycle at {case_id}")
        if case_id in done:
            return
        active.add(case_id)
        for previous in dependencies.get(case_id, []):
            visit(previous)
        active.remove(case_id)
        done.add(case_id)
        ordered.append(case_id)

    for case_id in sorted(ids):
        visit(case_id)
    return ordered


def capabilities(cases, mode: str) -> list[str]:
    result = set()
    for case in cases:
        fixtures = set(case.fixtures)
        if fixtures & {"ssh_required", "sftp_required"}:
            result.add("ssh")
        if "mysql_required" in fixtures:
            result.add("mysql")
        if mode == "native":
            result.add("display")
            if fixtures & {"jdtls_required", "java25_projects", "java_test_bundle", "java_sample_projects", "sortable_java_fixtures"}:
                result.add("java")
            if "java25_projects" in fixtures:
                result.add("java25")
            if "java_test_bundle" in fixtures or "debug" in case.tags:
                result.update({"java", "java-bundles"})
            if any("native_ime_keys" in step for step in case.steps):
                result.add("ime")
            if "linux_x11_required" in fixtures:
                result.add("x11")
    return sorted(result)


def make_plan(args) -> dict:
    cases = discover(Path("qa-ui-auto-tests/cases"))
    by_id = {case.id: case for case in cases}
    if len(by_id) != len(cases):
        raise ValueError("duplicate case IDs")
    policy = yaml.safe_load(POLICY.read_text(encoding="utf-8"))
    dependencies = yaml.safe_load(DEPENDENCIES.read_text(encoding="utf-8")) or {}
    known = set(by_id)
    registered = set(policy["cases"])
    if known != registered:
        raise ValueError(f"CI policy catalog differs: new={sorted(known-registered)}, removed={sorted(registered-known)}")
    # Validate the entire DAG, including currently unselected cases.
    dependency_order(set(dependencies), dependencies, known)
    platforms, modes = csv(args.platforms), csv(args.modes)
    if not platforms or set(platforms) - PLATFORMS.keys():
        raise ValueError("platforms must contain linux, windows and/or macos")
    if not modes or set(modes) - {"browser", "native"}:
        raise ValueError("modes must contain browser and/or native")
    features = load_features()
    feature_ids = {f.id for f in features}
    tags = {tag for case in cases for tag in case.tags}
    requested, wanted_features, wanted_tags = set(csv(args.case_ids)), set(csv(args.features)), set(csv(args.tags))
    for label, supplied, available in [("cases", requested, known), ("features", wanted_features, feature_ids),
                                        ("tags", wanted_tags, tags)]:
        if supplied - available:
            raise ValueError(f"unknown {label}: {sorted(supplied-available)}")
    explicit = requested | {c.id for c in cases if wanted_features.intersection(c.covers)
                            or wanted_tags.intersection(c.tags)}
    if args.scope in {"all", "smoke"} and explicit:
        raise ValueError("all/smoke cannot be combined with selectors; use selected or impacted")
    if args.scope == "selected" and not explicit:
        raise ValueError("selected scope requires case_ids, features or tags")
    head = commit(args.head or "HEAD")
    if head != commit("HEAD"):
        raise ValueError("checkout the requested head before planning")
    changed, base, ancestor, impact = [], None, None, None
    reasons = {cid: ["explicit selector"] for cid in explicit}
    if args.scope == "impacted":
        if not args.base:
            raise ValueError("impacted requires an explicit base")
        base = commit(args.base)
        ancestor, changed = diff_paths(base, head)
        # Removed mappings still contribute ownership.
        previous = subprocess.check_output(["git", "show", f"{base}:qa-ui-auto-tests/feature-list.md"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "features.md"
            path.write_bytes(previous)
            features = features + load_features(path)
        impact = impact_plan(cases, features, changed, "Linux", explicit)
        selected = set(impact["selected_cases"])
        if any(p.startswith((".github/", "qa-ui-auto-tests/ci/")) for p in changed):
            selected.update(known)
            impact["selection_reason"] = "shared CI execution/configuration changes"
        for cid in selected:
            reasons.setdefault(cid, []).append(impact["selection_reason"])
    elif args.scope == "selected":
        selected = explicit
    else:
        selected = known if args.scope == "all" else set(policy["smoke"])
        for cid in selected:
            reasons[cid] = [args.scope]
    ordered = dependency_order(selected | explicit, dependencies, known)
    for cid in ordered:
        reasons.setdefault(cid, ["prerequisite"])
    entries, gaps, not_applicable, reachable = [], [], [], set()
    for platform_key in platforms:
        target, runner, arch = PLATFORMS[platform_key]
        for mode in modes:
            eligible = []
            for cid in ordered:
                case = by_id[cid]
                if mode not in case.modes:
                    not_applicable.append({"case": cid, "platform": platform_key, "mode": mode,
                                           "reason": "case does not declare this mode"})
                    continue
                reason = native_support(case, target) if mode == "native" else browser_support(case, target)
                if reason:
                    not_applicable.append({"case": cid, "platform": platform_key, "mode": mode, "reason": reason})
                    continue
                if case.skip:
                    reason = f"case declares skip: {case.skip}"
                unavailable = policy.get("unavailable", {}).get(cid, {})
                reason = reason or unavailable.get(f"{platform_key}/{mode}")
                if reason:
                    gaps.append({"case": cid, "platform": platform_key, "mode": mode, "reason": reason})
                    continue
                eligible.append(case)
            ids = [c.id for c in eligible]
            for cid in ids:
                if set(dependencies.get(cid, [])) - set(ids):
                    raise ValueError(f"prerequisite unavailable for {platform_key}/{mode}/{cid}")
            if not ids:
                continue
            reachable.update(ids)
            entries.append({"id": f"{platform_key}-{mode}", "platform": target, "platform_key": platform_key,
                            "runner": runner, "arch": arch, "mode": mode, "selected_ids": ids,
                            "capabilities": capabilities(eligible, mode),
                            "case_digests": {c.id: input_digest(c.source_path) for c in eligible}})
    if explicit - reachable:
        raise ValueError(f"explicit cases unavailable in requested combinations: {sorted(explicit-reachable)}")
    if not entries and args.scope != "impacted":
        raise ValueError("selection contains no runnable cases")
    return {"schema": "qa-ui-auto.ci-selection.v1", "head": head, "base": base,
            "merge_base": ancestor, "scope": args.scope, "changed_paths": changed,
            "identity": execution_identity(Path.cwd()), "reasons": reasons, "impact": impact,
            "entries": entries, "gaps": gaps, "no_relevant_changes": not entries,
            "not_applicable": not_applicable,
            "run_id": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "unreviewed": [cid for cid in ordered if set(by_id[cid].tags) & {"needs-review", "legacy-imported"}]}


def selection_entry(path: Path, entry_id: str, *, verify: bool = True) -> tuple[dict, dict]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "qa-ui-auto.ci-selection.v1":
        raise ValueError("unsupported CI selection schema")
    matches = [e for e in manifest["entries"] if e["id"] == entry_id]
    if len(matches) != 1:
        raise ValueError(f"unknown/duplicate selection entry: {entry_id}")
    entry = matches[0]
    if verify:
        actual_identity = execution_identity(Path.cwd())
        actual_head = commit("HEAD")
        if actual_head != manifest["head"] or actual_identity != manifest["identity"]:
            details = []
            if actual_head != manifest["head"]:
                details.append(f"head {actual_head} != {manifest['head']}")
            for key in ("source_sha256", "runner_sha256"):
                if actual_identity.get(key) != manifest["identity"].get(key):
                    details.append(f"{key} differs ({actual_identity.get(key)} != {manifest['identity'].get(key)})")
            raise ValueError("CI selection source/runner identity does not match checkout: " + "; ".join(details))
        by_id = {c.id: c for c in discover(Path("qa-ui-auto-tests/cases"))}
        for cid in entry["selected_ids"]:
            if cid not in by_id or input_digest(by_id[cid].source_path) != entry["case_digests"][cid]:
                raise ValueError(f"CI case changed since planning: {cid}")
    return manifest, entry


def github_output(name: str, value: str) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(f"{name}={value}\n")


def aggregate(manifest: dict, root: Path) -> dict:
    from .runner_receipt import verify_runner_receipt
    entries, failures = [], []
    for entry in manifest["entries"]:
        entry_root = root / entry["id"]
        seen, totals = set(), Counter()
        errors = []
        summaries = sorted(entry_root.rglob("run-*/summary.json"))
        for path in summaries:
            try:
                summary = json.loads(path.read_text(encoding="utf-8"))
                receipt = json.loads(path.with_name("runner_receipt.json").read_text(encoding="utf-8"))
                if not verify_runner_receipt(receipt).get("valid"):
                    raise ValueError("invalid runner receipt")
                digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
                if not any(a.get("path") == "summary.json" and a.get("sha256") == digest for a in receipt["artifacts"]):
                    raise ValueError("receipt does not bind summary")
                if receipt.get("purpose") != entry["mode"] + "-runner":
                    raise ValueError("receipt mode differs")
                if receipt.get("exitCode") != summary["exit_code"]:
                    raise ValueError("receipt exit code differs")
                if (summary.get("dry_run") is not False or not summary.get("identity_stable")
                        or summary.get("identity") != manifest["identity"]):
                    raise ValueError("stale, unstable or dry-run evidence")
                if summary["mode"] != entry["mode"] or summary["platform"] not in {entry["platform"], "Darwin" if entry["platform"] == "macOS" else entry["platform"]}:
                    raise ValueError("wrong platform/mode")
                if entry["mode"] == "native":
                    identity = summary.get("native_identity", {})
                    build = json.loads((entry_root / "build-identity.json").read_text(encoding="utf-8"))
                    if (identity.get("identifier") != "com.taomni.app.qa"
                            or identity.get("binary_sha256") != build.get("binary_sha256")
                            or identity.get("source_sha256") != manifest["identity"]["source_sha256"]):
                        raise ValueError("native binary identity differs from build/source")
                ids = [c["id"] for c in summary["cases"]]
                counts = Counter(c["status"] for c in summary["cases"])
                expected_totals = {"total": len(ids), **{k: counts[k] for k in ("passed", "failed", "skipped")}}
                if summary.get("totals") != expected_totals or set(counts) - {"passed", "failed", "skipped"}:
                    raise ValueError("summary totals/statuses disagree with case results")
                if len(ids) != len(set(ids)):
                    raise ValueError("duplicate case IDs inside summary")
                if seen.intersection(ids) or set(ids) != set(summary["selection"]["selected"]):
                    raise ValueError("duplicate/mismatched case results")
                if not set(ids).issubset(entry["selected_ids"]):
                    raise ValueError("unplanned case results")
                for case in summary["cases"]:
                    cid = case["id"]
                    if case.get("case_sha256") != entry["case_digests"][cid]:
                        raise ValueError(f"case identity mismatch: {cid}")
                    totals[case["status"]] += 1
                    if case["status"] != "passed":
                        message = (case.get("failure") or {}).get("message") or case.get("fixtures_skipped") or case["status"]
                        failures.append({"entry": entry["id"], "case": cid, "message": message[:2500]})
                seen.update(ids)
            except (KeyError, ValueError, OSError) as exc:
                errors.append(f"{path.relative_to(root)}: {exc}")
        if seen != set(entry["selected_ids"]):
            errors.append(f"missing results: {sorted(set(entry['selected_ids'])-seen)}")
        outcome = entry_root / "ci-outcome.json"
        try:
            actual = json.loads(outcome.read_text(encoding="utf-8"))
            if actual.get("head") != manifest["head"] or actual.get("entry") != entry["id"]:
                errors.append("execution head/entry differs")
            if (actual.get("selection_sha256") != selection_digest(manifest)
                    or actual.get("run_id") != manifest.get("run_id")
                    or actual.get("attempt") != manifest.get("attempt")):
                errors.append("execution selection/run identity differs")
            if actual.get("exit_code") != 0:
                errors.append(actual.get("error", "execution failed"))
        except (OSError, ValueError):
            errors.append("missing execution outcome (build/setup/cancellation)")
        failures.extend({"entry": entry["id"], "case": "infrastructure", "message": e[:2500]} for e in errors)
        entries.append({"id": entry["id"], "selected": len(entry["selected_ids"]),
                        "counts": dict(totals), "errors": errors})
    return {"head": manifest["head"], "run_id": manifest.get("run_id"), "attempt": manifest.get("attempt"),
            "entries": entries, "failures": failures, "gaps": manifest["gaps"],
            "not_applicable": manifest.get("not_applicable", []),
            "unreviewed": manifest["unreviewed"], "passed": not failures}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    plan = subs.add_parser("plan")
    for name, default in [("scope", "smoke"), ("head", ""), ("base", ""),
                          ("platforms", "linux,windows,macos"), ("modes", "browser,native"),
                          ("case_ids", ""), ("features", ""), ("tags", "")]:
        plan.add_argument("--" + name.replace("_", "-"), default=os.environ.get("QA_" + name.upper()) or default)
    plan.add_argument("--output", type=Path, default=Path("qa-ui-auto-report/selection.json"))
    report = subs.add_parser("report")
    report.add_argument("--selection", type=Path, required=True)
    report.add_argument("--reports", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            if args.scope not in {"smoke", "all", "impacted", "selected"}:
                raise ValueError("unknown scope")
            result = make_plan(args)
            write_json(args.output, result)
            matrix = {"include": [{k: e[k] for k in ("id", "runner", "arch", "mode", "platform_key", "capabilities")} for e in result["entries"]]}
            github_output("matrix", json.dumps(matrix, separators=(",", ":")))
            github_output("has_cases", str(bool(result["entries"])).lower())
            github_output("head", result["head"])
            if summary_path := os.environ.get("GITHUB_STEP_SUMMARY"):
                lines = ["# QA selection", "", f"Scope: `{result['scope']}`; commit: `{result['head']}`.", ""]
                if result["base"]:
                    lines += [f"Base: `{result['base']}`; merge base: `{result['merge_base']}`.", "",
                              "Changed paths: " + ", ".join(f"`{p}`" for p in result["changed_paths"]), ""]
                for entry in result["entries"]:
                    lines += [f"<details><summary>{entry['id']}: {len(entry['selected_ids'])} cases</summary>", ""]
                    lines += [f"- `{cid}`: {', '.join(result['reasons'][cid])}" for cid in entry["selected_ids"]]
                    lines += ["", "</details>", ""]
                if not result["entries"]:
                    lines.append("No relevant executable cases; no platform execution claimed.")
                lines += ["", f"Not applicable: {len(result['not_applicable'])}; capability gaps: {len(result['gaps'])}."]
                with open(summary_path, "a", encoding="utf-8") as stream:
                    stream.write("\n".join(lines) + "\n")
            print(json.dumps(matrix, indent=2))
            return 0
        manifest = json.loads(args.selection.read_text(encoding="utf-8"))
        result = aggregate(manifest, args.reports)
        write_json(args.reports / "ci-summary.json", result)
        lines = ["# QA platform results", "", f"Commit: `{result['head']}`", "",
                 "| Combination | Selected | Passed | Failed | Skipped | Infrastructure errors |",
                 "|---|---:|---:|---:|---:|---:|"]
        for entry in result["entries"]:
            c = entry["counts"]
            lines.append(f"| {entry['id']} | {entry['selected']} | {c.get('passed',0)} | {c.get('failed',0)} | {c.get('skipped',0)} | {len(entry['errors'])} |")
        lines.extend(["", f"Declared capability gaps: {len(result['gaps'])}; unreviewed cases: {len(result['unreviewed'])}.",
                      "", "See selection.json and ci-summary.json for exact IDs, exclusions and failures."])
        for failure in result["failures"]:
            message = failure["message"].replace("\n", " ").replace("`", "'")[:500]
            lines.append(f"\n- `{failure['entry']}/{failure['case']}`: {message}")
        if not result["entries"]:
            lines.append("No relevant executable cases; no platform execution claimed.")
        text = "\n".join(lines) + "\n"
        (args.reports / "summary.md").write_text(text, encoding="utf-8")
        if path := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(path, "a", encoding="utf-8") as stream:
                stream.write(text)
        print(text)
        return 0 if result["passed"] else 1
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"qa-ci: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
