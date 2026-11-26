"""Locate the signed media renderer that matches the checkout and native platform."""
import json
import os
from pathlib import Path
import subprocess

from .module_signed_archive import load_artifact, platform_key


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        raise ValueError("The signed media package requires the native installer")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    receipt, archive, signature, _ = load_artifact(
        Path(os.environ["QA_SIGNED_TAOFFICE_VIDEO_ROOT"]), source, platform_key(),
        "taoffice-video", version=None,
    )
    (Path(ctx.case_dir) / "media-package.json").write_text(
        json.dumps(receipt, indent=2), encoding="utf-8",
    )
    ctx.values.update(media_archive=archive.as_posix(), media_signature=signature)
