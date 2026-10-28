"""Bound native input delivery while retaining every key and exceeded budget."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Callable

from qa_ui_auto.steps import StepError

KEY_BATCH_SIZE = 8


class BatchedInputSession:
    """Use the original paced W3C input; never retry an uncertain action."""

    def __init__(self, session: Any):
        self._session = session

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)

    def type_text(self, text: str) -> str:
        for offset in range(0, len(text), KEY_BATCH_SIZE):
            self._session.type_text(text[offset:offset + KEY_BATCH_SIZE])
        return f"typed {len(text)} chars"


def review_sample(raw: dict, *, keys: str, label: str, limit: float) -> dict:
    """Reject missing/mismatched samples; a slow complete sample stays valid."""
    count = len(keys)
    if (
        raw.get("label") != label
        or raw.get("captureText") is not False
        or raw.get("sampleCount") != count
        or raw.get("keydownCount") != count
        or raw.get("pendingKeyCount") != 0
        or raw.get("thresholdP95Ms") != limit
    ):
        raise ValueError("Incomplete or mismatched native typing measurement")
    samples = raw.get("samples", [])
    if (
        len(samples) != count
        or [sample.get("key") for sample in samples] != list(keys)
        or [event.get("key") for event in raw.get("keys", [])] != list(keys)
    ):
        raise ValueError("Native typing keys were lost, duplicated or reordered")
    mutation = [sample.get("mutationLatencyMs") for sample in samples]
    frame = [sample.get("nextFrameLatencyMs") for sample in samples]
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0
               for v in mutation + frame):
        raise ValueError("Unfinished or invalid native typing timing")
    mutation, frame = sorted(mutation), sorted(frame)
    index = math.ceil(count * .95) - 1
    if (
        mutation != raw.get("latencyMs")
        or frame != raw.get("nextFrameLatencyMs")
        or mutation[index] != raw.get("p95Ms")
        or mutation[-1] != raw.get("maxMs")
        or frame[index] != raw.get("nextFrameP95Ms")
    ):
        raise ValueError("Native typing tails or summary differ from raw samples")
    return {
        "label": label, "sampleCount": count, "p95Ms": mutation[index],
        "maxMs": mutation[-1], "nextFrameP95Ms": frame[index],
        "thresholdP95Ms": limit, "budgetPassed": mutation[index] <= limit,
        "batchSize": KEY_BATCH_SIZE,
    }


def measure(ctx: Any, verb: Callable, *, selector: str, keys: str,
            label: str, limit: float) -> dict:
    original_session = ctx.session
    ctx.session = BatchedInputSession(original_session)
    budget_error = None
    try:
        try:
            verb(ctx, {"selector": selector, "keys": keys, "capture_text": False,
                       "max_p95_ms": limit, "label": label})
        except StepError as error:
            # Only the final, fully recorded budget rejection is eligible for
            # continued comparison. Focus, transport and incomplete input fail.
            budget_error = error
    finally:
        ctx.session = original_session
    slug = "".join(ch if ch.isalnum() else "-" for ch in label).strip("-").lower()
    path = Path(ctx.case_dir) / f"native-editor-performance-{slug}.json"
    if budget_error is not None and not path.is_file():
        raise budget_error
    raw = json.loads(path.read_text())
    summary = review_sample(raw, keys=keys, label=label, limit=limit)
    if budget_error is not None:
        expected = (f"native editor input p95 {summary['p95Ms']:.2f} ms exceeds "
                    f"{limit:.2f} ms ({len(keys)} samples)")
        if summary["budgetPassed"] or str(budget_error) != expected:
            raise budget_error
    elif not summary["budgetPassed"]:
        raise ValueError("Native input exceeded its budget without reporting failure")
    return summary


def review_round(folder: Path) -> dict:
    groups = []
    for label, keys, limit in [("typing-warmup", "w" * 24, 1000),
                               ("typing-group1", "a" * 200, 150),
                               ("typing-group2", "b" * 200, 150)]:
        raw = json.loads((folder / f"native-editor-performance-{label}.json").read_text())
        groups.append(review_sample(raw, keys=keys, label=label, limit=limit))
    return {"groups": groups, "passed": all(g["budgetPassed"] for g in groups)}


def review_comparison(root: Path, records: dict) -> dict:
    labels = ["main-1", "candidate-1", "main-2", "candidate-2"]
    budgets = {label: review_round(root / label / "explorer") for label in labels}
    for label, budget in budgets.items():
        rec = records[label]
        if (rec["passed"] is not budget["passed"]
                or rec["metrics"]["explorer"]["inputBudgetPassed"] is not budget["passed"]
                or rec["metrics"]["explorer"]["inputBudgets"] != budget["groups"]):
            raise ValueError(label + " native input budget status differs from raw samples")
    return {"rounds": budgets, "candidatePassed": all(
        budgets[label]["passed"] for label in labels if label.startswith("candidate")
    )}
