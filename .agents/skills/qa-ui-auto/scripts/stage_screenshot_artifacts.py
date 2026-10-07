"""Stage native outputs under the entry report root, outside signed run directories."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time


def stage_macos_crashes(roots: list[Path], report: Path, since: float) -> dict:
    """Retain recent Taomni crash diagnostics without touching run receipts."""
    destination = report / "native-crash-reports"
    files = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.iterdir()):
            if (path.is_symlink() or not path.is_file()
                    or not path.name.lower().startswith("taomni")
                    or path.suffix not in {".ips", ".crash"}
                    or path.stat().st_mtime < since):
                continue
            destination.mkdir(parents=True, exist_ok=True)
            target = destination / path.name
            shutil.copy2(path, target)
            files.append({"path": path.name, "bytes": target.stat().st_size,
                          "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    report.mkdir(parents=True, exist_ok=True)
    manifest = {"files": files, "note": "Native crash diagnostics; not case pass evidence."}
    (report / "native-crash-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def stage(source: Path, report: Path) -> dict:
    destination = report / "screenshot-outputs"
    files = []
    if source.is_dir():
        destination.mkdir(parents=True, exist_ok=True)
        for path in sorted(source.iterdir()):
            if not path.is_file() or path.is_symlink():
                continue
            target = destination / path.name
            shutil.copy2(path, target)
            files.append({"path": path.name, "bytes": target.stat().st_size,
                          "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    report.mkdir(parents=True, exist_ok=True)
    manifest = {"source_exists": source.is_dir(), "files": files,
                "note": "Output inventory only; runner receipts determine case results."}
    (report / "screenshot-output-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--macos-crash-reports", action="store_true")
    args = parser.parse_args()
    stage(args.source, args.report)
    if args.macos_crash_reports and sys.platform == "darwin":
        roots = [Path.home() / "Library/Logs/DiagnosticReports", Path("/Library/Logs/DiagnosticReports")]
        since = time.time() - 3600
        # ReportCrash writes asynchronously. Only wait after an observed
        # abnormal app exit, and keep the original case failure untouched.
        crashed = False
        for path in args.report.glob("run-*/*/native-process.json"):
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            crashed |= not state.get("macos_lldb") and state.get("exit_code_after_capture") not in (None, 0)
        for attempt in range(6 if crashed else 1):
            manifest = stage_macos_crashes(roots, args.report, since)
            if manifest["files"] or not crashed or attempt == 5:
                break
            time.sleep(2)
