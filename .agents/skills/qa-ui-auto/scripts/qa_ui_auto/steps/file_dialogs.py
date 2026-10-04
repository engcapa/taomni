"""Browser chooser and download events triggered by actual UI controls."""
from pathlib import Path

from . import StepError, verb


def report_file(ctx, value):
    root = ctx.case_dir.parent.resolve()
    path = Path(value).resolve()
    if not path.is_relative_to(root):
        raise StepError("file dialog paths must remain inside the report root")
    return path


@verb("choose_file")
def choose_file(ctx, args):
    if ctx.dry_run:
        return
    path = report_file(ctx, args["path"])
    if not path.is_file():
        raise StepError(f"Input file is absent: {path}")
    with ctx.page.expect_file_chooser() as event:
        ctx.page.locator(args["trigger"]).click()
    event.value.set_files(str(path))


@verb("download_file")
def download_file(ctx, args):
    if ctx.dry_run:
        return
    path = report_file(ctx, args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with ctx.page.expect_download() as event:
        ctx.page.locator(args["trigger"]).click()
    download = event.value
    failure = download.failure()
    if failure:
        raise StepError(f"The download failed: {failure}")
    download.save_as(str(path))
    if not path.is_file():
        raise StepError("The download did not produce the declared artifact")
