"""Observe real bootstrap metadata after app readiness; never create it."""
import json
from pathlib import Path

from .fixtures.core_profile_state import read_generation
from .steps import StepError


def run(ctx, args):
    if (not isinstance(args, dict) or set(args) != {"phase", "path"}
            or args.get("phase") not in {"capture", "unchanged"}
            or not isinstance(args.get("path"), str) or not args["path"]):
        raise StepError("assert_core_profile_generation: expected phase and owned metadata path")
    phase, path = args["phase"], Path(args["path"])
    case = Path(ctx.case_dir).resolve()
    if (path.name != ".profile-state.json" or path.resolve() != path
            or not path.is_relative_to(case.parent) or path.is_relative_to(case)):
        raise StepError("Core profile observation escaped the run-owned profile")
    observation = {"phase": phase, "path": str(path), "passed": False}
    try:
        generation = read_generation(path)
        observation["generation"] = generation
        baseline = getattr(ctx, "_core_profile_baseline", None)
        if phase == "capture":
            if baseline is not None:
                raise StepError("Core generation baseline already captured; recapture would hide a restart change")
            ctx._core_profile_baseline = (path, generation)
        elif baseline != (path, generation):
            raise StepError("Core profile generation changed after normal restart or has no pre-restart baseline")
        observation["passed"] = True
        return "real core profile generation " + ("captured" if phase == "capture" else "unchanged")
    finally:
        with (case / "core-profile-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
