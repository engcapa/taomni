"""RDP probe report assertions and the modular release p95 allowance."""

import json
from typing import Any


P95_METRIC = "latency_ms.p95"
P95_ARTIFACT = "perf-latency.json"


def report_expectations(step: dict, *, modular_rdp_p95: bool) -> dict:
    expect = step["expect"]
    if not modular_rdp_p95 or step["path"] != P95_ARTIFACT or P95_METRIC not in expect:
        return expect
    baseline = expect[P95_METRIC]
    return {**expect, P95_METRIC: {**baseline, "max": 2 * baseline["max"]}}


def _lookup(report: Any, dotted: str) -> Any:
    current = report
    for part in dotted.split("."):
        if isinstance(current, list) and part.isdigit():
            current = current[int(part)] if int(part) < len(current) else None
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def check_expectations(report: Any, expect: dict, label: str) -> list[str]:
    problems = []
    for dotted, rule in expect.items():
        value = _lookup(report, str(dotted))
        rules = rule if isinstance(rule, dict) else {"equals": rule}
        for op, wanted in rules.items():
            ok = True
            if op == "equals":
                ok = value == wanted
            elif op == "min":
                ok = isinstance(value, (int, float)) and value >= wanted
            elif op == "max":
                ok = isinstance(value, (int, float)) and value <= wanted
            elif op == "exists":
                ok = (value is not None) == bool(wanted)
            elif op == "contains":
                ok = value is not None and str(wanted) in (json.dumps(value) if not isinstance(value, str) else value)
            elif op == "excludes":
                # Absent counts as excluded: a format that was never listed.
                text = "" if value is None else (value if isinstance(value, str)
                                                 else json.dumps(value, ensure_ascii=False))
                ok = str(wanted) not in text
            elif op == "length_min":
                ok = isinstance(value, (list, dict, str)) and len(value) >= wanted
            else:
                problems.append(f"{label}: unknown expectation operator {op!r} for {dotted}")
                continue
            if not ok:
                problems.append(f"{label}: {dotted} {op} {wanted!r} failed (actual {value!r})")
    return problems
