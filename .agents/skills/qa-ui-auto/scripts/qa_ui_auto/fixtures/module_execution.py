"""Lifetime of a noexec fault on exactly one installed QA module version."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform

from linux_noexec import NoExecBind
from ..steps import StepError


def state(ctx):
    owner = getattr(ctx, "fixture_context", None) or ctx
    value = getattr(owner, "module_execution", None)
    if not isinstance(value, NoExecBind):
        raise StepError("module_execution_probe requires its hosted noexec fixture")
    return value


def setup(ctx):
    if (platform.system() != "Linux" or os.environ.get("GITHUB_ACTIONS") != "true"
            or (ctx.cfg.get("app") or {}).get("mode") != "native"):
        raise StepError("module_execution requires a GitHub-hosted Linux native runner")
    receipt = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text())
    root = Path(receipt["pluginRoot"])
    ctx.module_execution = NoExecBind(root / "hello-plugin/versions/0.1.0",
                                     Path(ctx.case_dir).resolve().parent)


def teardown(ctx):
    state(ctx).restore()
