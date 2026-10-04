"""Independent host-byte observations for live native transfer assertions."""
from __future__ import annotations

import json
from pathlib import Path
import time

from .steps import StepError


def assert_file_progress(ctx, args):
    path = Path(args["path"]).resolve()
    if not path.is_relative_to(Path(ctx.case_dir).resolve()):
        raise StepError("assert_file_progress: file must belong to this case report")
    state, full_size = args["state"], args["full_size"]
    duration = float(args.get("sample_sec", 2))
    deadline = time.monotonic() + float(args.get("timeout_sec", 10))
    rows = []
    result = False
    try:
        while True:
            now = time.monotonic()
            size = path.stat().st_size if path.exists() else None
            rows.append({"monotonic": now, "bytes": size})
            if state == "incomplete":
                result = size is None or size < full_size
                break
            sizes = [row["bytes"] for row in rows]
            if state == "growing" and size is not None and size > 0 and size < full_size:
                result = any(prior is not None and prior < size for prior in sizes[:-1])
                if result:
                    break
            if state == "stable" and now - rows[0]["monotonic"] >= duration:
                result = size is not None and 0 < size < full_size and all(prior == size for prior in sizes)
                break
            if now >= deadline:
                break
            time.sleep(.1)
        if not result:
            raise StepError(f"assert_file_progress: {path.name} did not satisfy {state}; byte samples {[row['bytes'] for row in rows]}")
        return f"host file {path.name} is {state}; {len(rows)} independent byte samples"
    finally:
        with (Path(ctx.case_dir) / "host-file-progress.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"path": str(path), "state": state, "fullSize": full_size, "passed": result, "samples": rows}) + "\n")
