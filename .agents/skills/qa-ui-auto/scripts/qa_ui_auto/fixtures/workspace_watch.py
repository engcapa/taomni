"""Real home-root observation; mutations remain inside the report's public fixture."""
from pathlib import Path
from typing import Any

from . import workspace_language_files


def setup(ctx: Any) -> None:
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("workspace_watch requires the real native filesystem watcher")
    workspace_language_files.setup(ctx)
    ctx.values["workspace_host_home"] = Path.home().as_posix()
