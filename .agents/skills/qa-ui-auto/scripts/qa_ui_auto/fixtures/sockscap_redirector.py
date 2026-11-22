"""Stage the upstream signed macOS launcher on the disposable native runner."""

import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

CASE_ID = "TC-MODULES-080"
APP = Path("/Applications/Mitmproxy Redirector.app")
EXECUTABLE = APP / "Contents/MacOS/Mitmproxy Redirector"
ROOT = Path(__file__).resolve().parents[6]


def prepare(ctx):
    if ctx.case_id != CASE_ID or platform.system() != "Darwin" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("Redirector installation requires its hosted macOS native case")
    listing = subprocess.check_output(["/usr/bin/systemextensionsctl", "list"], text=True, timeout=10)
    if "org.mitmproxy.macos-redirector.network-extension" in listing:
        raise RuntimeError("First-use approval requires a runner without a registered Redirector")
    if APP.exists():
        return  # The production start path verifies the installed upstream signature and digests.
    subprocess.run(["bash", str(ROOT / "scripts/stage-mitmproxy-redirector-macos.sh"), "--stage"],
                   check=True, cwd=ROOT, timeout=150)
    archive = ROOT / "src-tauri/resources/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar"
    with tempfile.TemporaryDirectory(dir=APP.parent, prefix=".taomni-qa-redirector-") as root:
        subprocess.run(["/usr/bin/tar", "-xf", str(archive), "-C", root], check=True, timeout=30)
        (Path(root) / APP.name).rename(APP)
        ctx.redirector_inode = (APP.stat().st_dev, APP.stat().st_ino)


def teardown(ctx):
    owned = getattr(ctx, "redirector_inode", None)
    if owned and APP.exists() and (APP.stat().st_dev, APP.stat().st_ino) == owned:
        shutil.rmtree(APP)
