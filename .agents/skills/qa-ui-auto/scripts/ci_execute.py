"""Supervise one hosted QA job; preserve runner results and clean owned processes."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

import yaml

from qa_ui_auto.ci import selection_entry, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    outcome = {"head": None, "entry": args.entry, "exit_code": 2, "stage": "selection"}
    write_json(args.report / "ci-outcome.json", outcome)
    scripts = Path(__file__).resolve().parent
    children = []

    def cancelled(signum, frame):
        raise RuntimeError(f"job cancelled (signal {signum})")

    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        manifest, entry = selection_entry(args.selection, args.entry)
        outcome.update(head=manifest["head"], stage="prepare")
        with ExitStack() as stack:
            config = {"app": {"base_url": "http://127.0.0.1:5000", "mode": entry["mode"]},
                      "worker": {"parallel": 1 if "ssh" in entry["capabilities"] else 2},
                      "report": {"dir": str(args.report), "keep_runs": 0}}
            if set(entry["capabilities"]) & {"ssh", "mysql"}:
                from ci_services import Services
                stack.enter_context(Services(args.report / "services", entry["capabilities"], config))
            if "java" in entry["capabilities"]:
                from ci_toolchains import prepare_java
                prepare_java(args.report / "java", entry["capabilities"])
            cfg_path = args.report / "config.yaml"
            cfg_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
            if entry["mode"] == "native":
                from ci_desktop import Desktop
                stack.enter_context(Desktop(args.report / "desktop", entry["capabilities"]))
                outcome["stage"] = "build"
                write_json(args.report / "ci-outcome.json", outcome)
                subprocess.run([sys.executable, str(scripts / "native_build.py")], check=True)
                from native_build import identity_path, qa_binary
                (args.report / "build-identity.json").write_bytes(identity_path(qa_binary()).read_bytes())
            else:
                log = stack.enter_context((args.report / "vite.log").open("w", encoding="utf-8"))
                import shutil
                pnpm = shutil.which("pnpm")
                if not pnpm:
                    raise RuntimeError("pnpm not found")
                process = subprocess.Popen([pnpm, "dev", "--host", "127.0.0.1", "--strictPort"],
                                           stdout=log, stderr=subprocess.STDOUT,
                                           env={**os.environ, "DEV_PROXY_ALLOW_PRIVATE": "1"})
                children.append(process)
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                for _ in range(90):
                    if process.poll() is not None:
                        raise RuntimeError("Vite exited; see vite.log")
                    try:
                        with opener.open(config["app"]["base_url"], timeout=2) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(1)
                else:
                    raise RuntimeError("Vite not ready in 90s")
            outcome["stage"] = "cases"
            write_json(args.report / "ci-outcome.json", outcome)
            command = [sys.executable, "-m", "qa_ui_auto", "run", "--selection", str(args.selection),
                       "--selection-entry", args.entry, "--config", str(cfg_path), "--report-dir", str(args.report),
                       "--keep-runs", "0", "--require-pass", "--mode", entry["mode"]]
            # Keep the interpreter/process owning the runner receipt unchanged.
            runner_log = stack.enter_context((args.report / "runner.log").open("w", encoding="utf-8"))
            case_process = subprocess.Popen(command, stdout=runner_log, stderr=subprocess.STDOUT)
            children.append(case_process)
            outcome["exit_code"] = case_process.wait()
            if outcome["exit_code"]:
                outcome["error"] = "selected cases did not all pass; see original runner reports"
            outcome["stage"] = "complete"
    except BaseException as exc:
        outcome.update(exit_code=2, error=f"{type(exc).__name__}: {exc}")
        print(outcome["error"], file=sys.stderr)
    finally:
        for process in reversed(children):
            if process.poll() is None:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        write_json(args.report / "ci-outcome.json", outcome)
    return outcome["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
