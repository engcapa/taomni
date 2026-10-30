"""Exercise the real home with an explicitly owned disposable public folder."""
import shutil
import tempfile
import json
import stat
from pathlib import Path
from typing import Any

from . import workspace_home_layout, workspace_language_files

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
    layout = workspace_home_layout.populate(root)
    ctx.values["workspace_home_deep_document"] = root.name + "/" + layout["deepDocument"]
    ctx.values["workspace_home_nested_path"] = root.name + "/Nested"
    for index, relative in enumerate(layout["nestedLevels"], 1):
        ctx.values[f"workspace_home_level_{index}"] = root.name + "/" + relative
    # This report contains only owned workload dimensions and relative paths.
    # It never inventories unrelated files in the runner's actual HOME.
    if hasattr(ctx, "case_dir"):
        report = ctx.case_dir / "home-fixture-layout.json"
        report.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")
        ctx.values["workspace_home_layout_report"] = report.as_posix()


def teardown(ctx: Any) -> None:
    owned = ctx.values.get("workspace_home_fixture_root")
    if not owned:
        return
    root = Path(owned)
    # Never glob or traverse a personal project/profile during cleanup.
    if root.parent != Path.home().resolve() or not root.name.startswith("taomni-qa-perf-") or root.is_symlink():
        raise RuntimeError("Refusing to clean an unowned home performance fixture")
    def remove_readonly(function, path, error):
        target = Path(path)
        if not isinstance(error[1], PermissionError) or target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
            raise error[1]
        # Git objects are read-only on Windows. Retry only within this owned
        # fixture and let a still-locked file or any unrelated failure surface.
        target.chmod(stat.S_IMODE(target.stat().st_mode) | stat.S_IWRITE)
        function(path)
    shutil.rmtree(root, onerror=remove_readonly)
