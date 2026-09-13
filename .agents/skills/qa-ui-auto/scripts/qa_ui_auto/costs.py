"""Read runner timings to locate verification cost; never certify coverage or performance."""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import statistics
from .report_paths import summaries


def seconds(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return float(value)
    return None


def analyze(roots: list[Path], case_ids: set[str] | None = None) -> dict:
    paths = set()
    problems = []
    for root in roots:
        if root.is_file():
            paths.add(root.resolve())
        elif root.is_dir():
            found = set(summaries(root))
            paths.update(found)
            if not found:
                problems.append({"path": str(root), "reason": "no summary.json found"})
        else:
            problems.append({"path": str(root), "reason": "path does not exist"})
    runs = []
    rows = {}
    ignored = []
    for path in sorted(paths):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict):
                raise ValueError("summary must be an object")
            if data.get("dry_run") is not False:
                ignored.append({"path": str(path), "reason": "dry-run or no execution marker"})
                continue
            mode, platform = data.get("mode"), data.get("platform")
            if mode not in ("browser", "native") or platform not in ("Windows", "Linux", "Darwin", "macOS"):
                raise ValueError("missing or invalid mode/platform")
            cases = data.get("cases")
            if not isinstance(cases, list) or not all(isinstance(c, dict) and isinstance(c.get("id"), str)
                                                      and c.get("status") in ("passed", "failed", "skipped") for c in cases):
                raise ValueError("invalid cases or outcomes")
            # Validate before accumulating; malformed inputs must not leave partial totals.
            if any(not isinstance(c.get("timings", {}), dict)
                   or not isinstance(c.get("step_timings", []), list)
                   or not all(isinstance(s, dict) for s in c.get("step_timings", [])) for c in cases):
                raise ValueError("invalid timing containers")
            selected = [c for c in cases if not case_ids or c["id"] in case_ids]
            if not selected:
                continue
            runs.append({"path": str(path), "mode": mode, "platform": platform,
                         "wall_sec": seconds(data.get("duration_sec")),
                         "selected_cases": len(selected), "total_cases": len(cases)})
            for case in selected:
                key = (case["id"], mode, platform)
                row = rows.setdefault(key, {"id": key[0], "mode": mode, "platform": platform,
                                           "outcomes": Counter(), "durations": [], "missing_duration": 0,
                                           "phases": {}, "verbs": {}, "reports": []})
                row["outcomes"][case["status"]] += 1
                row["reports"].append(str(path))
                duration = seconds(case.get("duration_sec"))
                if duration is None:
                    row["missing_duration"] += 1
                else:
                    row["durations"].append(duration)
                for phase, value in case.get("timings", {}).items():
                    value = seconds(value)
                    if value is not None:
                        row["phases"].setdefault(phase, []).append(value)
                for step in case.get("step_timings", []):
                    value = seconds(step.get("duration_sec"))
                    if isinstance(step.get("verb"), str) and value is not None:
                        row["verbs"].setdefault(step["verb"], []).append(value)
        except (OSError, ValueError, TypeError) as exc:
            problems.append({"path": str(path), "reason": str(exc)})
    result_rows = []
    for row in rows.values():
        durations = row.pop("durations")
        row["attempts"] = sum(row["outcomes"].values())
        row["case_time_sum_sec"] = sum(durations)
        row["case_time_median_sec"] = statistics.median(durations) if durations else None
        row["case_time_max_sec"] = max(durations) if durations else None
        for field in ("phases", "verbs"):
            row[field] = {name: {"sum_sec": sum(values), "samples": len(values), "max_sec": max(values)}
                          for name, values in sorted(row[field].items(), key=lambda item: -sum(item[1]))}
        result_rows.append(row)
    if case_ids:
        absent = case_ids - {r["id"] for r in result_rows}
        if absent:
            problems.append({"path": "requested cases", "reason": "no executed reports for: " + ", ".join(sorted(absent))})
    return {"schema": "qa-ui-auto.costs.v1", "runs": runs,
            "cases": sorted(result_rows, key=lambda r: -r["case_time_sum_sec"]),
            "ignored": ignored, "problems": problems,
            "scope": "Timing diagnostics only; receipts/freshness not validated. Repeated attempts may use different sources/configs. "
                     "Case sums include failures/skips and may overlap with browser workers. Run wall time includes unselected cases; "
                     "do not add it to case/phase/step totals. Build time and key-to-screen latency are not measured here."}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports", type=Path, action="append", required=True, help="summary.json or report directory; repeatable")
    parser.add_argument("--case", action="append", help="exact ID to inspect; repeatable")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    data = analyze(args.reports, set(args.case or []))
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(data["scope"])
        print(f"Runs: {len(data['runs'])}; case/platform groups: {len(data['cases'])}")
        for row in data["cases"]:
            print(f"{row['id']} [{row['mode']}/{row['platform']}]: {row['attempts']} attempts, "
                  f"{row['case_time_sum_sec']:.2f}s case sum, outcomes={dict(row['outcomes'])}, "
                  f"missing timings={row['missing_duration']}")
            for field in ("phases", "verbs"):
                print(f"  {field}: " + ", ".join(f"{name}={v['sum_sec']:.2f}s" for name, v in row[field].items()))
        for group in ("ignored", "problems"):
            for item in data[group]:
                print(f"{group}: {item['path']}: {item['reason']}")
    return 2 if data["problems"] or not data["cases"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
