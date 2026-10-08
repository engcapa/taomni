"""Run the hosted QA selection flow against persistent local fixtures.

The fixture lease is external to this process. Start it once with the commands
in README.md, then this script performs the same plan -> per-platform entry ->
receipt flow as qa-ui-auto-platforms.yml.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".agents/skills/qa-ui-auto/scripts"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--case-ids", required=True)
    parser.add_argument("--modes", default="browser,native")
    parser.add_argument("--report-dir", type=Path, default=ROOT / "qa-ui-auto-report/local-platforms")
    parser.add_argument("--reuse-server", action="store_true")
    args = parser.parse_args()
    args.report_dir.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONPATH": str(SCRIPTS)}
    selection = args.report_dir / "selection.json"
    plan = [sys.executable, "-m", "qa_ui_auto.ci", "plan", "--scope", "selected",
            "--platforms", "windows", "--modes", args.modes, "--case-ids", args.case_ids,
            "--output", str(selection)]
    result = subprocess.run(plan, cwd=ROOT, env=env)
    if result.returncode:
        return result.returncode
    import json
    entries = json.loads(selection.read_text(encoding="utf-8"))["entries"]
    if args.reuse_server:
        env["QA_LOCAL_REUSE_SERVER"] = "1"
    for entry in entries:
        report = args.report_dir / entry["id"]
        command = [sys.executable, str(SCRIPTS / "ci_execute.py"), "--selection", str(selection),
                   "--entry", entry["id"], "--report", str(report), "--local-config", str(args.config)]
        result = subprocess.run(command, cwd=ROOT, env=env)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
