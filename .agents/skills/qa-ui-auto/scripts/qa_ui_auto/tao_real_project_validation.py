"""Bounded model feedback for actual failures in commercial project tests."""
import re

from .steps import StepError
from .tao_real_development import RESULTS, approve_files, test_project


def checked_tests(flow, root, command, stage, allowed, *, minimum=6):
    """Retain failed processes; require a real approved repair and successful rerun.

    A malformed command proposal, missing approval/result or transport failure is
    an automation/product failure and never starts another paid request. Only
    an observed test-process exit/count failure may enter the development loop.
    """
    retryable = {
        "Actual test process did not have the expected exit state",
        "The native test process did not execute the required tests",
    }
    for attempt in range(3):
        label = stage if attempt == 0 else f"{stage}-after-repair-{attempt}"
        try:
            test_project(flow, command, flow.calls + 1, label, minimum=minimum)
            return
        except StepError as error:
            if str(error) not in retryable:
                raise
            results = flow.read(RESULTS)
            output = results[-1] if results else ""
            match = re.search(r"(?:Completed|Execution failed)\s*exit\s+(-?\d+)", output)
            if not match or int(match[1]) not in (0, 1):
                raise
            flow.record(label + "-observed-failure", dict(
                exitCode=int(match[1]), minimumTests=minimum,
                nativeProcess=True, output=output[-8000:], reason=str(error),
            ), "failed")
            flow.screenshot(label + "-observed-failure")
            if attempt == 2:
                raise

        names = ", ".join(sorted(allowed))
        flow.send(
            "The actual approved native test process did not satisfy the project "
            "acceptance criteria. Diagnose the confirmed output below and inspect "
            "the bound project files. Repair implementation defects or incorrect "
            "test isolation while preserving the required behavior and all existing "
            f"scenarios (at least {minimum} tests). Do not delete tests, weaken "
            "assertions, invent successful results or change the test command. "
            "Propose only necessary write_file tao-action fences, one per file, "
            f"at most five, limited to these bound-workspace files: {names}. "
            "No shell commands; wait for explicit approval.\n\n"
            "Actual native result:\n" + output[-8000:]
        )
        flow.reply(label + "-model-repair", flow.calls, seconds=300)
        approve_files(flow, root, allowed)
