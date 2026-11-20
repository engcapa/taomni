"""Run the existing RDP performance case against a verified installed Linux build."""
from pathlib import Path
from types import SimpleNamespace

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.config import resolve
from qa_ui_auto.deadline import Deadline, using_deadline
from qa_ui_auto.fixtures import rdp_server_required
from qa_ui_auto.fixtures.module_legacy_mfa import close_installed_desktop, desktop_action, installed_desktop
from qa_ui_auto.native_steps import NativeStepContext
from qa_ui_auto.rdp_helpers.report_assertions import P95_METRIC, report_expectations
from qa_ui_auto.testcase import load_case, step_verb_and_args


CASE = Path("qa-ui-auto-tests/cases/TC-RDPS-PERF-01-performance-budget.testcase.yaml")


def measure(candidate, probe, source, work, report):
    case = load_case(CASE)
    evidence = report / "rdp-performance"
    evidence.mkdir()
    config = {"app": {"mode": "native", "native_binary": str(candidate), "rdp_probe_binary": str(probe)},
              "rdp": {"modular_p95": True},
              "webdriver": {"startup_timeout": 45}}
    observer = SimpleNamespace(cfg=config, env={}, values={})
    result = {"case": case.id, "caseSha256": digest(CASE), "applicationSource": source,
              "applicationSha256": digest(candidate), "probeSha256": digest(probe),
              "steps": [], "passed": False}
    try:
        rdp_server_required.setup(observer)
        with installed_desktop(observer, candidate, work / "rdp-profile", evidence, "desktop") as (driver, session):
            session.deadline = Deadline(case.timeout_sec)
            steps = NativeStepContext(session, evidence, observer.cfg, fixture_context=observer)
            try:
                with using_deadline(session.deadline):
                    for index, step in enumerate(case.steps, start=1):
                        verb, args = step_verb_and_args(step)
                        observation = {"step": index, "verb": verb, "passed": False}
                        result["steps"].append(observation)
                        if verb == "assert_json_file":
                            expectations = report_expectations(args, modular_rdp_p95=True)
                            if expectations is not args["expect"]:
                                observation["latencyP95BudgetMs"] = {
                                    "reference": args["expect"][P95_METRIC]["max"],
                                    "applied": expectations[P95_METRIC]["max"],
                                }
                        desktop_action(steps, verb, resolve(args, cfg=observer.cfg, env=observer.env, fixture=observer.values))
                        observation["passed"] = True
                    desktop_action(steps, "assert_no_runtime_errors", None)
                result["shutdown"] = close_installed_desktop(driver, session, candidate)
            finally:
                steps.restore_host_permissions()
        result["passed"] = True
    finally:
        write_json(evidence / "installed-rdp-performance.json", result)
    return result
