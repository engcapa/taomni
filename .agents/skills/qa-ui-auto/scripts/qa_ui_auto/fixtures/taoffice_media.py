"""Locate a signed TaOffice renderer that matches the checkout and native platform."""
import json
import os
from pathlib import Path
import subprocess

from .module_signed_archive import load_artifact, platform_key


def setup(ctx):
    _setup(ctx, "taoffice-video", "media")


def setup_pdf(ctx):
    _setup(ctx, "taoffice-pdf", "pdf")


def setup_excel(ctx):
    _setup(ctx, "taoffice-excel", "excel")


def setup_word(ctx):
    _setup(ctx, "taoffice-word", "word")


def setup_project(ctx):
    _setup(ctx, "taoffice-project", "project")


def setup_ppt(ctx):
    _setup(ctx, "taoffice-ppt", "ppt")


def setup_visio(ctx):
    _setup(ctx, "taoffice-visio", "visio")


def _setup(ctx, slug, name):
    if ctx.cfg["app"]["mode"] != "native":
        raise ValueError("A signed TaOffice package requires the native installer")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    variable = "QA_SIGNED_" + slug.upper().replace("-", "_") + "_ROOT"
    receipt, archive, signature, _ = load_artifact(
        Path(os.environ[variable]), source, platform_key(), slug, version=None,
    )
    (Path(ctx.case_dir) / f"{name}-package.json").write_text(
        json.dumps(receipt, indent=2), encoding="utf-8",
    )
    ctx.values.update({f"{name}_archive": archive.as_posix(), f"{name}_signature": signature})
