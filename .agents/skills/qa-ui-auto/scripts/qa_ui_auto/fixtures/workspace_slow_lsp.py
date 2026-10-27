"""Real stdio language server held at initialize until the case releases it."""
import json
from pathlib import Path
import sys

from . import workspace_explorer


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("workspace_slow_lsp requires native IPC and a real child process")
    workspace_explorer.setup(ctx)
    root = Path(ctx.values["platform_workspace_root"])
    events = root / "lsp-events.txt"
    gate = root / "release-lsp.txt"
    script = Path(__file__).with_name("workspace_slow_lsp_server.py").resolve()
    events.write_text("", encoding="utf-8")
    gate.unlink(missing_ok=True)
    preset = "typescript-javascript"
    ctx.values.update(
        slow_lsp_events=events.as_posix(), slow_lsp_gate=gate.as_posix(),
        slow_lsp_prefs=json.dumps({preset: "__custom__"}),
        slow_lsp_command=json.dumps({preset: {
            "command": sys.executable,
            "args": " ".join(json.dumps(arg) for arg in [script.as_posix(), events.as_posix(), gate.as_posix()]),
        }}),
    )
