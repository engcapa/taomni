"""Host-file verbs shared with native mode for runner-host fixtures.

The VNC fixture's event log and command file live on the runner host, so a
case can prove what reached the "remote" (and drive it) the same way in both
modes. Browser-mode application files live in the in-browser VFS, never on
the host, so here both verbs are confined to the run's report root: they can
reach fixture files, never stand in for a native disk-effect proof.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import StepContext, StepError, verb


def _report_root_path(ctx: StepContext, args: Any, name: str) -> None:
    if not isinstance(args, dict) or "path" not in args:
        raise StepError(f"{name}: expected {{path, ...}}")
    root = ctx.case_dir.parent.resolve()
    target = Path(str(args["path"])).expanduser().resolve()
    if not target.is_relative_to(root):
        raise StepError(f"{name}: browser mode reads/writes only inside the report root {root}")


@verb("host_write_file")
def step_host_write_file(ctx: StepContext, args: Any) -> None:
    if ctx.dry_run:
        return
    from ..native_steps import _host_write_file

    _report_root_path(ctx, args, "host_write_file")
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    _host_write_file(ctx, args)  # type: ignore[arg-type]


@verb("assert_file_contains")
def step_assert_file_contains(ctx: StepContext, args: Any) -> None:
    if ctx.dry_run:
        return
    from ..native_steps import _assert_file_contains

    _report_root_path(ctx, args, "assert_file_contains")
    _assert_file_contains(ctx, args)  # type: ignore[arg-type]


@verb("assert_json_file")
def step_assert_json_file(ctx: StepContext, args: Any) -> None:
    if ctx.dry_run:
        return
    _report_root_path(ctx, args, "assert_json_file")
    from ..rdp_steps import _do_assert_json_file
    _do_assert_json_file(ctx, args)
