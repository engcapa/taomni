"""Development-time QA case contract checks for pull requests.

The hosted platform workflow uses this module as an advisory reminder when
product code changes without an executable QA case change. Catalog drift is a
hard error because it makes the planner unable to produce a trustworthy matrix.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

import yaml


CASE_ROOT = Path("qa-ui-auto-tests/cases")
POLICY_PATH = Path("qa-ui-auto-tests/ci/policy.yaml")
PRODUCT_PREFIXES = ("src/", "src-tauri/src/", "vite-plugins/")
UNIT_TEST_PREFIXES = ("src/", "src-tauri/tests/", ".agents/skills/qa-ui-auto/scripts/")


def changed_paths(base: str, head: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMRD", f"{base}...{head}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return sorted({path.replace("\\", "/") for path in result.stdout.splitlines() if path})


def is_case_path(path: str) -> bool:
    return path.startswith(f"{CASE_ROOT.as_posix()}/") and path.endswith(".testcase.yaml")


def is_unit_test_path(path: str) -> bool:
    return (
        path.endswith((".test.ts", ".test.tsx", ".test.js", ".test.jsx", "_test.rs"))
        and path.startswith(UNIT_TEST_PREFIXES)
    )


def is_product_path(path: str) -> bool:
    if not path.startswith(PRODUCT_PREFIXES):
        return False
    return not is_unit_test_path(path)


def load_case_ids() -> set[str]:
    ids: set[str] = set()
    for path in CASE_ROOT.rglob("*.testcase.yaml"):
        document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        case_id = document.get("id")
        if isinstance(case_id, str) and case_id.strip():
            ids.add(case_id.strip())
    return ids


def load_policy_ids() -> set[str]:
    document = yaml.safe_load(POLICY_PATH.read_text(encoding="utf-8")) or {}
    return {case_id for case_id in document.get("cases", []) if isinstance(case_id, str)}


def evaluate(paths: list[str], *, case_ids: set[str], policy_ids: set[str]) -> dict:
    case_paths = [path for path in paths if is_case_path(path)]
    product_paths = [path for path in paths if is_product_path(path)]
    unit_paths = [path for path in paths if is_unit_test_path(path)]
    errors = []
    warnings = []
    missing = sorted(case_ids - policy_ids)
    removed = sorted(policy_ids - case_ids)
    if missing or removed:
        errors.append(
            "QA case catalog differs from policy.yaml: "
            f"new={missing}, removed={removed}. Add/remove IDs in the same change."
        )
    if product_paths and not case_paths:
        warnings.append(
            "Product files changed without a qa-ui-auto case change. "
            "Add or update a focused case in qa-ui-auto-tests/cases/ and register its ID "
            "in qa-ui-auto-tests/ci/policy.yaml, or record a concrete reason in the design/PR."
        )
    return {
        "product_paths": product_paths,
        "case_paths": case_paths,
        "unit_paths": unit_paths,
        "errors": errors,
        "warnings": warnings,
        "ok": not errors,
    }


def render(result: dict, paths: list[str], base: str, head: str) -> str:
    lines = ["### qa-ui-auto development case contract", "", f"Diff: `{base}...{head}`", ""]
    if not paths:
        lines.append("No changed files were found.")
    else:
        lines.extend(
            [
                f"- Product files: {len(result['product_paths'])}",
                f"- QA case files: {len(result['case_paths'])}",
                f"- Focused unit/test files: {len(result['unit_paths'])}",
            ]
        )
    for message in result["warnings"]:
        lines.extend(["", f"::warning::{message}"])
    for message in result["errors"]:
        lines.extend(["", f"::error::{message}"])
    lines.extend(
        [
            "",
            "Before requesting review, run:",
            "```text",
            "$env:PYTHONPATH = '.agents/skills/qa-ui-auto/scripts'",
            "python -m qa_ui_auto.audit --gate",
            "python -m qa_ui_auto.ci plan --scope selected --case-ids <TC-ID>",
            "```",
        ]
    )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args(argv)
    paths = changed_paths(args.base, args.head)
    result = evaluate(paths, case_ids=load_case_ids(), policy_ids=load_policy_ids())
    output = render(result, paths, args.base, args.head)
    print(output, end="")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        Path(summary_path).write_text(output, encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
