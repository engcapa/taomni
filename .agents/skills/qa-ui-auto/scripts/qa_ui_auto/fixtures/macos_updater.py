"""Download authentic signed release assets once; install only a disposable app."""
from pathlib import Path
import os
import platform

from .. import updater_fixture


def setup(ctx):
    if ctx.cfg.get("app", {}).get("mode") != "native" or platform.system() != "Darwin":
        raise RuntimeError("macos_updater requires the real macOS QA application")
    updater_fixture.stop_active()
    profile = Path(os.environ["NEWMOB_DATA_DIR"]) / "com.taomni.app.qa"
    mode = "slow" if ctx.case_id == "TC-UPDATE-MACOS-002" else "broken"
    updater_fixture.ACTIVE = updater_fixture.UpdaterFixture(
        Path(ctx.case_dir), Path(ctx.report_root) / "_updater-assets", profile, mode=mode,
    )
    ctx.values["updater_app"] = str(updater_fixture.ACTIVE.install_root)


def teardown(ctx):
    updater_fixture.stop_active()
