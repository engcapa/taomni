"""Validate authored behavior-to-step mappings and attach actual execution evidence.

This checks traceability, not completeness of the requirements or visual quality.
Draft contracts are deliberately distinguishable from reviewed contracts.
"""
from __future__ import annotations

from typing import Any

import argparse
import json
from pathlib import Path

import yaml


def is_check(step: dict) -> bool:
    verb, args = next(iter(step.items()))
    if verb.startswith("assert_") or verb in {"wait_for", "native_editor_performance", "parity005_wait_pending"}:
        return True
    if verb == "eval_readonly":
        return args.get("expect_truthy", True) or "contains" in args
    if verb == "save_race_trace":
        return any(args.get(k) for k in (
            "expect_contains", "expect_events", "require_ack_hashes", "require_settled_kind"))
    if verb == "parity005_trace":
        return any(key in args for key in ("fetch", "resolve", "pending"))
    if verb == "parity005_native_trace":
        return "phase" in args
    return False


def validate_contract(doc: dict, *, require_review: bool = False) -> list[str]:
    contract = doc.get("verification")
    if not contract:
        return ["missing verification contract"] if require_review else []
    errors = []
    steps = doc["steps"]
    if require_review and contract["review"] != "reviewed":
        errors.append("verification contract still needs semantic review")
    ids = set()
    for req in contract["requirements"]:
        prefix = req["id"]
        if prefix in ids:
            errors.append(f"duplicate requirement {prefix}")
        ids.add(prefix)
        refs = req["actions"] + req["results"] + [c["step"] for c in req["checkpoints"]]
        if any(i < 1 or i > len(steps) for i in refs):
            errors.append(f"{prefix}: step reference outside 1..{len(steps)}")
            continue
        checkpoints = {c["step"] for c in req["checkpoints"]}
        for i in checkpoints | set(req["results"]):
            if not is_check(steps[i - 1]):
                errors.append(f"{prefix}: step {i} is not an asserting observation")
        if not set(req["results"]) <= checkpoints:
            errors.append(f"{prefix}: results must name explained checkpoints")
        if req["actions"] and max(req["results"]) <= max(req["actions"]):
            errors.append(f"{prefix}: no result after the last claimed action")
    return errors


def execution_contract(contract: dict, result: dict, *, dry_run: bool) -> dict:
    executed = {s["index"]: s.get("status", "unknown") for s in result.get("step_timings", [])}
    requirements = []
    for req in contract.get("requirements", []):
        refs = sorted(set(req["actions"] + [c["step"] for c in req["checkpoints"]]))
        evidence = [{"step": i, "status": "unrun" if dry_run else executed.get(i, "unrun")} for i in refs]
        statuses = {e["status"] for e in evidence}
        status = "passed" if statuses == {"passed"} else "failed" if "failed" in statuses else "unrun"
        requirements.append({"id": req["id"], "requirement": req["requirement"],
                             "status": status, "evidence": evidence})
    return {"review": contract.get("review", "missing"), "requirements": requirements,
            "visual": contract.get("visual", []), "native": contract.get("native", []),
            "note": "Boundary checklists are not execution passes; screenshots require visual review."}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=Path("qa-ui-auto-tests/cases"))
    parser.add_argument("--gate", action="store_true", help="require reviewed contracts for every selected case")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    from .testcase import validate_doc
    rows = []
    for path in sorted(args.cases.rglob("*.testcase.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        errors = validate_doc(doc, source=str(path))
        if not errors:
            errors = validate_contract(doc, require_review=True)
        rows.append({"id": doc.get("id"), "path": str(path), "errors": errors})
    errors = sum(bool(row["errors"]) for row in rows)
    report = {"total": len(rows), "reviewed": len(rows) - errors, "gaps": errors, "cases": rows}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Behavior contracts: {len(rows) - errors}/{len(rows)} reviewed; {errors} gaps")
        for row in rows:
            for error in row["errors"]:
                print(f"  {row['id']}: {error}")
    return int(args.gate and (errors > 0 or not rows))


if __name__ == "__main__":
    raise SystemExit(main())
