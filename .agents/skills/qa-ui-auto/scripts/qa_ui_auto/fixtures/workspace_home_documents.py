"""Exercise the real home with an explicitly owned disposable public folder."""
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import workspace_language_files

PUBLIC_SOURCE_TEXT = "def public_value():\n    return 42\n"


def setup(ctx: Any) -> None:
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("workspace_home_documents requires the native home directory")
    workspace_language_files.setup(ctx)
    home = Path.home().resolve()
    root = Path(tempfile.mkdtemp(prefix="taomni-qa-perf-", dir=home))
    if "_" in root.name:
        renamed = root.with_name(root.name.replace("_", "-"))
        root.rename(renamed)
        root = renamed
    ctx.values["workspace_home_fixture_root"] = root.as_posix()
    ctx.values["workspace_host_home"] = home.as_posix()
    ctx.values["workspace_home_documents_path"] = root.name + "/Documents"
    ctx.values["workspace_home_fixture_name"] = root.name
    shutil.copytree(ctx.values["platform_workspace_root"], root, dirs_exist_ok=True)
    (root / "Documents/qa-public-source.py").write_text(PUBLIC_SOURCE_TEXT, encoding="utf-8")


def teardown(ctx: Any) -> None:
    owned = ctx.values.get("workspace_home_fixture_root")
    if not owned:
        return
    root = Path(owned)
    # Never glob or traverse a personal project/profile during cleanup.
    if root.parent != Path.home().resolve() or not root.name.startswith("taomni-qa-perf-") or root.is_symlink():
        raise RuntimeError("Refusing to clean an unowned home performance fixture")
    shutil.rmtree(root)
