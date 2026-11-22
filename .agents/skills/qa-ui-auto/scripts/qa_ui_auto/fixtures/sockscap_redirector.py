"""Stage the upstream signed macOS launcher on the disposable native runner."""

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import zipfile

CASE_ID = "TC-MODULES-080"
INSTALLER_CASE = "TC-MODULES-082"
APP = Path("/Applications/Mitmproxy Redirector.app")
EXECUTABLE = APP / "Contents/MacOS/Mitmproxy Redirector"
INSTALLER = "resources/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar"
PINNED_SHA256 = "b8ea49940489560bb76b231a064aa823cf3d3e8a0787eac4a456611f26c96a7f"


def prepare(ctx, signed_archive, installed):
    if ctx.case_id not in (CASE_ID, INSTALLER_CASE) or platform.system() != "Darwin" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("Redirector installation requires its hosted macOS native case")
    listing = subprocess.check_output(["/usr/bin/systemextensionsctl", "list"], text=True, timeout=10)
    if "org.mitmproxy.macos-redirector.network-extension" in listing:
        raise RuntimeError("First-use approval requires a runner without a registered Redirector")
    ctx.values.update(sockscap_redirector_archive=(installed / INSTALLER).as_posix(),
                      sockscap_redirector_sha256=PINNED_SHA256)
    if ctx.case_id == INSTALLER_CASE:
        if APP.exists():
            raise RuntimeError("Installer integrity case requires a fresh Mac without the system app")
        return
    if APP.exists():
        return  # The production start path verifies the installed upstream signature and digests.
    with tempfile.TemporaryDirectory(dir=APP.parent, prefix=".taomni-qa-redirector-") as root:
        archive = Path(root) / "redirector.tar"
        with zipfile.ZipFile(signed_archive) as package, package.open(INSTALLER) as source:
            with archive.open("xb") as target:
                shutil.copyfileobj(source, target)
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != PINNED_SHA256:
                raise RuntimeError("Packaged installer differs from the pinned upstream archive")
        subprocess.run(["/usr/bin/tar", "-xf", str(archive), "-C", root], check=True, timeout=30)
        (Path(root) / APP.name).rename(APP)
        ctx.redirector_inode = (APP.stat().st_dev, APP.stat().st_ino)


def check_archive(ctx, phase):
    if getattr(ctx, "dry_run", False):
        return "dry-run; no installed resource changed"
    fixture = ctx.fixture_context
    if not fixture or fixture.case_id != INSTALLER_CASE or phase not in ("change", "restore"):
        raise RuntimeError("Expected the isolated macOS installer integrity case")
    archive = Path(fixture.values["sockscap_redirector_archive"])
    if APP.exists():
        raise RuntimeError("The unverified installer created a system app")
    if phase == "change":
        with archive.open("r+b") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != PINNED_SHA256:
                raise RuntimeError("Installed resource did not match the upstream archive")
            stream.seek(0)
            original = stream.read(1)
            stream.seek(0)
            fixture.redirector_original_byte = original
            stream.write(bytes([original[0] ^ 1]))
    else:
        restore_archive(fixture)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if (digest == PINNED_SHA256) != (phase == "restore"):
        raise RuntimeError(f"Unexpected installer digest after {phase}")
    receipt = {"phase": phase, "archive": str(archive), "sha256": digest, "systemAppPresent": False,
               "sourceSha": fixture.signed_sockscap["sourceSha"], "packageSha256": fixture.signed_sockscap["sha256"]}
    (ctx.case_dir / f"redirector-installer-{phase}.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return f"Installed Redirector resource {phase} verified"


def restore_archive(ctx):
    original = getattr(ctx, "redirector_original_byte", None)
    if original is not None:
        with Path(ctx.values["sockscap_redirector_archive"]).open("r+b") as stream:
            stream.write(original)
        ctx.redirector_original_byte = None


def teardown(ctx):
    restore_archive(ctx)
    owned = getattr(ctx, "redirector_inode", None)
    if owned and APP.exists() and (APP.stat().st_dev, APP.stat().st_ino) == owned:
        shutil.rmtree(APP)
