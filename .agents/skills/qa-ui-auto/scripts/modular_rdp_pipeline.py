"""Compare the native RDP display and encoder on one hosted desktop."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import secrets
import signal
import subprocess
import time

from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import isolated_desktop
from qa_ui_auto.native_steps import NativeStepContext, run_native_step
from qa_ui_auto.rdp_helpers.report_assertions import P95_METRIC, report_expectations
from qa_ui_auto.testcase import load_case, step_verb_and_args

CASE = Path("qa-ui-auto-tests/cases/TC-RDPS-PERF-01-performance-budget.testcase.yaml")
SERVER = "host_perf::serve_desktop"
ROUTES = ("in-process", "encoder-host")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def perf_steps(case):
    """Keep the probe arguments and the budgets in the reviewed native case."""
    trials = {}
    budgets = {}
    current_helper = None
    for step in case.steps:
        verb, args = step_verb_and_args(step)
        if verb == "host_helper":
            current_helper = args if args["action"] == "start" else None
        elif verb == "rdp_probe":
            trials[args["scenario"]] = (current_helper, args)
        elif verb == "assert_json_file":
            budgets[args["path"]] = args
    if set(trials) != {"connect", "latency", "throughput"}:
        raise RuntimeError("The RDP performance case must provide all three probes")
    if set(budgets) != {f"{args['artifact']}.json" for _, args in trials.values()}:
        raise RuntimeError("The RDP performance case must provide a budget for every probe")
    return [
        (scenario, helper, args, budgets[f"{args['artifact']}.json"])
        for scenario, (helper, args) in trials.items()
    ]


def wait_for_listener(process, path):
    deadline = time.monotonic() + 20
    while not path.is_file():
        if process.poll() is not None:
            raise RuntimeError(f"RDP harness exited during startup ({process.returncode})")
        if time.monotonic() >= deadline:
            raise RuntimeError("RDP harness did not publish its listener")
        time.sleep(0.05)
    return read_json(path)


@contextmanager
def trial_server(binary, route, directory, sample_point=None):
    windows = platform.system() == "Windows"
    environment = {**os.environ, "QA_RDP_GATE_ROUTE": route, "QA_RDP_GATE_REPORT": str(directory)}
    if sample_point is not None:
        environment["QA_RDP_FRAME_SAMPLE_POINT"] = sample_point
    with (directory / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [str(binary), "--ignored", "--exact", SERVER, "--nocapture"],
            env=environment,
            stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, start_new_session=not windows,
        )
    try:
        encoder = wait_for_listener(process, directory / "encoder.json")
        if (encoder["pid"] != process.pid) != (route == "encoder-host"):
            raise RuntimeError(f"Unexpected RDP encoder process for {route}")
        yield encoder
    finally:
        process.stdin.close()
        try:
            status = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            if windows:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, timeout=10)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            raise RuntimeError("RDP trial did not exit after closing its control pipe")
        if status:
            raise RuntimeError(f"RDP trial exited with status {status}, see {directory / 'server.log'}")


@contextmanager
def measurement_desktop(root, config, system):
    ctx = NativeStepContext(None, root, config)
    try:
        if system == "Windows":
            run_native_step(ctx, "host_helper", {"action": "start", "name": "backdrop", "mode": "backdrop"})
        yield
    finally:
        ctx.restore_host_permissions()


def measure(binary, probe, root):
    system = platform.system()
    if system not in {"Linux", "Windows", "Darwin"}:
        raise RuntimeError("The desktop encoder comparison requires Linux, Windows or macOS")
    case = load_case(CASE)
    root.mkdir(parents=True, exist_ok=False)
    report = {
        "case": case.id, "caseSha256": digest(CASE),
        "harnessSha256": digest(binary), "probeSha256": digest(probe),
        "platform": system, "platformVersion": platform.version(), "trials": [],
    }
    config = {"app": {"rdp_probe_binary": str(probe)}, "rdp": {"modular_p95": True}}
    environment = {"QA_RDP_USER": "qa-rdp", "QA_RDP_PASSWORD": "Qa1_" + secrets.token_hex(12)}
    failures = []
    with isolated_desktop(environment), measurement_desktop(root, config, system):
        for scenario, helper, args, budget in perf_steps(case):
            expectations = report_expectations(budget, modular_rdp_p95=True)
            if scenario == "latency":
                report["latencyP95BudgetMs"] = {
                    "reference": budget["expect"][P95_METRIC]["max"],
                    "applied": expectations[P95_METRIC]["max"],
                }
            sample_point = None
            if system == "Windows" and scenario == "latency":
                probe_args = args["args"]
                sample_x = max(0, probe_args["x"] + probe_args.get("sample-dx", -40))
                sample_y = max(0, probe_args["y"] + probe_args.get("sample-dy", -40))
                sample_point = f"{sample_x},{sample_y}"
            for route in ROUTES:
                directory = root / scenario / route
                directory.mkdir(parents=True)
                receipt = {"route": route, "scenario": scenario, "passed": False}
                report["trials"].append(receipt)
                ctx = NativeStepContext(None, directory, config)
                try:
                    with trial_server(binary, route, directory, sample_point) as encoder:
                        receipt["encoder"] = encoder
                        with isolated_desktop({"QA_RDP_PORT": str(encoder["port"])}):
                            if helper is not None:
                                run_native_step(ctx, "host_helper", helper)
                            run_native_step(ctx, "rdp_probe", args)
                            run_native_step(ctx, "assert_json_file", budget)
                    if route == "encoder-host":
                        transport = read_json(directory / "transport.json")
                        if transport["bitmaps"] == 0 or transport["bitmapBytes"] == 0:
                            raise RuntimeError("No screen pixels reached the encoder host")
                        if system == "Linux" and scenario == "throughput" and transport["damageRegions"] == 0:
                            raise RuntimeError("The animation produced no damage regions across the hop")
                        receipt["transport"] = transport
                    receipt["passed"] = True
                    print(f"{scenario} {route} passed", flush=True)
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                    receipt["error"] = str(error)
                    failures.append(f"{scenario} {route}: {error}")
                    print(failures[-1], flush=True)
                finally:
                    ctx.restore_host_permissions()
                    write_json(root / "comparison.json", report)
    if failures:
        raise RuntimeError("\n".join(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    measure(args.harness.resolve(strict=True), args.probe.resolve(strict=True), args.report.resolve())
