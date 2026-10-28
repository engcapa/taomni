"""Summarize all raw comparison samples without removing tails or failed runs."""

from pathlib import Path
import json, math, sys
import argparse
from workspace_perf import common
from workspace_perf.native_input import review_comparison

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
root = args.out.resolve()
plan = json.loads((root / "plan.json").read_text())
labels = ["main-1", "candidate-1", "main-2", "candidate-2"]
records = {
    label: json.loads((root / label / "result.json").read_text()) for label in labels
}
for label, r in records.items():
    assert r.get("workloadCompleted") and r["sourceStable"], (label, r.get("error"))
    assert r["metrics"]["explorer"].get("workloadCompleted"), label
    expected_head = plan["baseline"] if label.startswith("main") else plan["candidate"]
    assert r["head"] == expected_head, "Unexpected comparison revision"

assert all(
    r["harnessSha256"] == records["main-1"]["harnessSha256"] for r in records.values()
), "Measurement harness changed between revisions"
assert all(
    {k: r["environment"][k] for k in ["width", "height", "dpr", "userAgent"]}
    == {
        k: records["main-1"]["environment"][k]
        for k in ["width", "height", "dpr", "userAgent"]
    }
    for r in records.values()
), "WebView/viewport conditions differ"


def samples(record, key):
    m = record["metrics"]
    e = m["explorer"]
    if key == "firstTerminal":
        return [m["sessionCreate"]["samples"][0]["elapsedMs"]]
    if key == "additionalTerminals":
        return [s["elapsedMs"] for s in m["sessionCreate"]["samples"][1:]]
    if key in ["sessionSwitch"]:
        return [s["elapsedMs"] for s in m[key]["samples"]]
    if key in ["echoAt1", "echoAt24"]:
        return m[key]["samplesMs"]
    if key in ["outputObserved", "outputProducer"]:
        return [
            (
                m["output2MiB"]["observedElapsedMs"]
                if key == "outputObserved"
                else m["output2MiB"]["producer"]["elapsedMs"]
            )
        ]
    if key in ["coldWorkspaceOpen", "fileOpen1MiB"]:
        return [e[key]["elapsedMs"]]
    if key in [
        "folderExpandCold",
        "folderExpandWarm",
        "treeScroll",
        "fileOpen64KiB",
        "fileTabSwitch",
    ]:
        return [s["elapsedMs"] for s in e[key]["samples"]]
    if key.startswith("typing"):
        field = "latencyMs" if key == "typingMutation" else "nextFrameLatencyMs"
        values = []
        for path in sorted(
            (root / record["label"] / "explorer").glob(
                "native-editor-performance-typing-group*.json"
            )
        ):
            values.extend(json.loads(path.read_text())[field])
        assert len(values) == 400, (record["label"], len(values))
        return values
    raise ValueError(key)


keys = [
    "firstTerminal",
    "additionalTerminals",
    "sessionSwitch",
    "echoAt1",
    "echoAt24",
    "outputObserved",
    "outputProducer",
    "coldWorkspaceOpen",
    "folderExpandCold",
    "folderExpandWarm",
    "treeScroll",
    "fileOpen64KiB",
    "fileTabSwitch",
    "fileOpen1MiB",
    "typingMutation",
    "typingNextFrame",
]
rows = []
for key in keys:
    raw = {label: samples(record, key) for label, record in records.items()}
    per = {label: common.stats(values) for label, values in raw.items()}
    main = common.stats(raw["main-1"] + raw["main-2"])
    candidate = common.stats(raw["candidate-1"] + raw["candidate-2"])
    floor = 30 if key in ["echoAt1", "echoAt24"] else 20
    baseline_spread = abs(per["main-1"]["p95"] - per["main-2"]["p95"])
    noise = max(floor, baseline_spread)
    cutoff = main["p95"] * 1.15 + noise
    rows.append(
        {
            "metric": key,
            "units": "ms",
            "baseline": main,
            "candidate": candidate,
            "perRun": per,
            "raw": raw,
            "baselineRunSpreadMs": baseline_spread,
            "noiseMs": noise,
            "cutoffP95Ms": cutoff,
            "ratio": candidate["p95"] / main["p95"] if main["p95"] else None,
            "regression": candidate["p95"] > cutoff,
            "instrumentationBound": key in ["outputObserved", "echoAt1", "echoAt24"],
        }
    )
input_review = review_comparison(root, records)
input_budgets = input_review["rounds"]
candidate_input_passed = input_review["candidatePassed"]
resources = []
for metric, location in [
    ("idle24", "sessions"),
    ("afterTabsClose", "sessions"),
    ("idle24Files", "explorer"),
    ("idleLargeEditor", "explorer"),
]:
    for field, units, floor in [
        ("pssMiB", "MiB", 32),
        ("cpuCoreFraction", "CPU cores", 0.03),
    ]:
        values = {
            label: (
                rec["metrics"][metric]
                if location == "sessions"
                else rec["metrics"]["explorer"][metric]
            )[field]
            for label, rec in records.items()
        }
        before = [values["main-1"], values["main-2"]]
        after = [values["candidate-1"], values["candidate-2"]]
        baseline = sum(before) / 2
        candidate = sum(after) / 2
        noise = max(floor, abs(before[0] - before[1]))
        cutoff = baseline * 1.15 + noise
        resources.append(
            {
                "metric": metric + "." + field,
                "units": units,
                "raw": values,
                "baselineMean": baseline,
                "candidateMean": candidate,
                "noise": noise,
                "cutoff": cutoff,
                "regression": candidate > cutoff,
            }
        )
result = {
    "schema": 1,
    "baselineHeads": sorted(
        {r["head"] for l, r in records.items() if l.startswith("main")}
    ),
    "candidateHeads": sorted(
        {r["head"] for l, r in records.items() if l.startswith("candidate")}
    ),
    "plan": json.loads((root / "plan.json").read_text()),
    "latency": rows,
    "resources": resources,
    "absoluteInputBudgets": input_budgets,
    "allWithinAllowance": candidate_input_passed and not any(r["regression"] for r in rows + resources),
    "warmup": "All typing warmup raw artifacts retained separately; no measured sample removed.",
    "lifecycle": {
        label: {
            "processesAfterTabClose": r["metrics"]["afterTabsClose"]["processes"],
            "processesAfterSessionExit": r["metrics"]["afterSessionExitProcesses"],
            "ownedCleanup": r["metrics"]["cleanupOwnedProcesses"],
            "explorerAfterExit": r["metrics"]["explorer"]["afterExitProcesses"],
        }
        for label, r in records.items()
    },
}
common.retain(root / "comparison.json", result)
print(
    json.dumps(
        {
            "withinAllowance": result["allWithinAllowance"],
            "latencyRegressions": [r["metric"] for r in rows if r["regression"]],
            "resourceRegressions": [r["metric"] for r in resources if r["regression"]],
            "candidateInputBudgetPassed": candidate_input_passed,
        },
        indent=2,
    )
)

sys.exit(0 if result["allWithinAllowance"] else 1)
