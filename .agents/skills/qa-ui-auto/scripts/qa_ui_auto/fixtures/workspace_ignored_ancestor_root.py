"""Real workspace below an ignored ancestor, retained for watcher evidence."""
from pathlib import Path

from . import platform_workspace_root


def setup(ctx):
    if ctx.cfg.get("app", {}).get("mode") != "native":
        raise RuntimeError("workspace_ignored_ancestor_root requires native disk events")
    platform_workspace_root.setup(ctx)
    root = Path(ctx.values["platform_workspace_root"]) / ".cache" / "workspace"
    for name, content in platform_workspace_root.SEED_FILES.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content.encode("utf-8"))
    ctx.values["platform_workspace_root"] = root.as_posix()
