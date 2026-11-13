"""Browser entry for the shared passive file activation observer."""
from typing import Any

from . import StepContext, verb


@verb("measure_workspace_file_open")
def measure(ctx: StepContext, args: Any) -> None:
    from ..file_open_probe import run, validate
    validate(args)
    if not ctx.dry_run:
        run(ctx, args)


@verb("assert_file_open_bytes")
def file_bytes(ctx: StepContext, args: Any) -> None:
    from ..file_open_observation import run
    run(ctx, args, mode="browser")


@verb("assert_download")
def assert_download(ctx: StepContext, args: Any) -> None:
    from . import StepError
    from pathlib import Path
    import hashlib
    import json
    if not isinstance(args, dict) or set(args) - {"trigger", "filename", "contains"} or not args.get("trigger") or not args.get("filename"):
        raise StepError("assert_download: expected trigger, filename and optional contains")
    if ctx.dry_run:
        return
    record = {"mode": "browser", "trigger": args["trigger"], "passed": False}
    try:
        with ctx.page.expect_download(timeout=30000) as pending:
            ctx.page.locator(args["trigger"]).click()
        download = pending.value
        if download.suggested_filename != args["filename"]:
            raise StepError("assert_download: suggested filename differs")
        if download.failure():
            raise StepError("assert_download: " + str(download.failure()))
        target = ctx.case_dir / ("download-" + str(ctx.step_index) + "-" + Path(download.suggested_filename).name)
        download.save_as(target)
        data = target.read_bytes()
        if not data or any(text.encode("utf-8") not in data for text in args.get("contains", [])):
            raise StepError("assert_download: empty download or missing required bytes")
        record.update(passed=True, path=str(target), size=len(data), sha256=hashlib.sha256(data).hexdigest())
    finally:
        with (ctx.case_dir / "file-open-downloads.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")


@verb("reveal_project_tree_row")
def reveal_tree(ctx: StepContext, args: Any) -> None:
    from ..project_tree_reveal import run, validate
    validate(args)
    if not ctx.dry_run:
        run(ctx, args)
