"""Independent fixture/controlled-temp byte assertions, never product viewer reads."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .steps import StepError

READ_VFS = """async (path) => {
  const vfs = await import('/src/stubs/localVfs.ts');
  try { await vfs.vfsStat(path); }
  catch (error) { if (String(error).toLowerCase().includes('not found')) return {exists: false}; throw error; }
  return {exists: true, bytes: Array.from(new Uint8Array(await vfs.vfsReadBytes(path)))};
}"""


def validate(args: Any) -> dict:
    if not isinstance(args, dict) or set(args) - {"path", "selector", "remember", "absent", "equals", "sha256", "timeout_sec"}:
        raise StepError("assert_file_open_bytes: expected path/selector/remember with equals, sha256 or absent")
    if sum(key in args for key in ("equals", "sha256", "absent")) != 1:
        raise StepError("assert_file_open_bytes: one byte postcondition is required")
    if "sha256" in args and not re.fullmatch(r"[a-f0-9]{64}", str(args["sha256"])):
        raise StepError("assert_file_open_bytes: sha256 must be lowercase hex")
    if not args.get("path") and not args.get("selector") and not args.get("remember"):
        raise StepError("assert_file_open_bytes: target required")
    return args


def run(ctx: Any, args: Any, *, mode: str) -> str:
    args = validate(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no byte observation"
    manifest = json.loads((ctx.case_dir / "file-open-fixture.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "qa.file-open-fixture.v1" or manifest.get("mode") != mode:
        raise StepError("assert_file_open_bytes: missing or mismatched fixture")
    if not hasattr(ctx, "_file_open_paths"):
        ctx._file_open_paths = {}
    path = args.get("path")
    observed_temp = False
    if args.get("selector"):
        script = "return Array.from(document.querySelectorAll(arguments[0])).map(function(el){return el.getAttribute('data-path');});"
        paths = ctx.session.execute(script, [args["selector"]]) if mode == "native" else ctx.page.locator(args["selector"]).evaluate_all("els => els.map(el => el.getAttribute('data-path'))")
        if not isinstance(paths, list) or len(paths) != 1 or not paths[0]:
            raise StepError("assert_file_open_bytes: expected one observed file viewer path")
        path = paths[0]
        observed_temp = True
    if not path:
        path = ctx._file_open_paths.get(args.get("remember"))
    if not isinstance(path, str) or not path:
        raise StepError("assert_file_open_bytes: no retained path")
    if mode == "native":
        if Path(path).is_symlink():
            raise StepError("assert_file_open_bytes: symlink refused")
        target = Path(path).resolve()
        fixture_root = Path(manifest["root"]).resolve()
        is_owned_temp = target.parent.name.startswith("taomni-viewer-") and target.is_relative_to(Path(tempfile.gettempdir()).resolve())
        retained = path in ctx._file_open_paths.values()
        if not target.is_relative_to(fixture_root) and not (is_owned_temp and (observed_temp or retained)):
            raise StepError("assert_file_open_bytes: path outside fixture or observed controlled temp")
        if target.is_symlink():
            raise StepError("assert_file_open_bytes: symlink refused")
        def read() -> dict:
            return {"exists": target.is_file(), "bytes": list(target.read_bytes()) if target.is_file() else []}
    else:
        if not path.startswith(manifest["root"] + "/") and not (path.startswith("/preview/.viewer-temp/") and (observed_temp or path in ctx._file_open_paths.values())):
            raise StepError("assert_file_open_bytes: path outside fixture or observed VFS temp")
        def read() -> dict:
            return ctx.page.evaluate(READ_VFS, path)
    if args.get("remember"):
        ctx._file_open_paths[args["remember"]] = path
    started = time.monotonic()
    record: dict[str, Any] = {"mode": mode, "path": path, "passed": False, "samples": []}
    try:
        while True:
            value = read()
            data = bytes(value.get("bytes", []))
            digest = hashlib.sha256(data).hexdigest()
            if args.get("absent"):
                matched = not value["exists"]
            elif "equals" in args:
                matched = bool(value["exists"]) and data == str(args["equals"]).encode("utf-8")
            else:
                matched = bool(value["exists"]) and digest == args["sha256"]
            record["samples"].append({"exists": value["exists"], "size": len(data), "sha256": digest, "elapsedMs": (time.monotonic() - started) * 1000})
            if matched:
                record["passed"] = True
                return f"{mode} independent byte postcondition matched: {path}"
            if time.monotonic() - started >= float(args.get("timeout_sec", 10)):
                raise StepError(f"assert_file_open_bytes: bytes/existence differ for {path}")
            time.sleep(0.1)
    finally:
        with (ctx.case_dir / "file-open-byte-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")


def native(ctx: Any, args: Any) -> str:
    return run(ctx, args, mode="native")
