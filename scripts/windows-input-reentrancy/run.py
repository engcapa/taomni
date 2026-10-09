"""Probe the production-locked Tao version, or an explicit historical baseline.

This is a Win32 library regression, not an RDP login or a packaged-app UI test.
The probe uses only its own hidden window; it never sends global desktop input.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
from pathlib import Path
import subprocess
import sys
import tomllib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tao-version", help="historical comparison; defaults to production Cargo.lock")
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("requires Windows")
    root = Path(__file__).resolve().parents[2]
    lock = root / "src-tauri/Cargo.lock"
    version = args.tao_version or next(
        p["version"] for p in tomllib.loads(lock.read_text(encoding="utf-8"))["package"]
        if p["name"] == "tao"
    )
    report_dir = args.report_dir.resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    project = report_dir / "probe"
    project.mkdir(exist_ok=True)
    source = Path(__file__).with_name("main.rs")
    manifest = (
        '[package]\nname = "windows-input-reentrancy"\nversion = "0.0.0"\nedition = "2024"\n'
        '[workspace]\n[dependencies]\ntao = { version = ' + json.dumps("=" + version) + ' }\n'
        '[[bin]]\nname = "windows-input-reentrancy"\npath = ' + json.dumps(source.as_posix()) + '\n'
    )
    (project / "Cargo.toml").write_text(manifest, encoding="utf-8")
    with (report_dir / "build.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            ["cargo", "build", "--manifest-path", str(project / "Cargo.toml")],
            cwd=root, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300,
        )
    binary = project / "target/debug/windows-input-reentrancy.exe"
    results = []
    for key in ("down", "up", "sysdown", "sysup"):
        for focus in ("set", "kill"):
            try:
                completed = subprocess.run([str(binary), key, focus], capture_output=True, text=True, timeout=12)
                item = {"key": key, "focus": focus, "exit_code": completed.returncode,
                        "stdout": completed.stdout, "stderr": completed.stderr}
            except subprocess.TimeoutExpired as exc:
                item = {"key": key, "focus": focus, "exit_code": 124,
                        "stdout": (exc.stdout or b"").decode(errors="replace"),
                        "stderr": "Probe timed out; child terminated by subprocess.run"}
            results.append(item)
            print(json.dumps(item), flush=True)
    report = {"platform": platform.platform(), "tao_version": version,
              "production_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
              "historical_override": args.tao_version is not None,
              "probe_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "probe_lock_sha256": hashlib.sha256((project / "Cargo.lock").read_bytes()).hexdigest(),
              "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "results": results}
    (report_dir / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if all(r["exit_code"] == 0 for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
