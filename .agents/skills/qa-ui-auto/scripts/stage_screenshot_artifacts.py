"""Stage native outputs under the entry report root, outside signed run directories."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


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
    args = parser.parse_args()
    stage(args.source, args.report)
