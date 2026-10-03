"""Sortable-members Java fixture for ED-AUDIT-015.

Copies the in-repo maven-single sample and adds ``SortMembers.java`` with
unsorted members (methods before fields, zebra before apple), so the
Rearrange Code gate case can drive the live JDT LS ``source.sortMembers``
action end to end. A host-side fixture (not host_write_file) is required
because host_write_file only overwrites existing files, and the shared
checkout sample must not gain scenario-specific files (other cases pin its
tree/positions).

The SortMembers bytes below are the exact literals the consuming case
references (pre sha256 68142fea...) — keep them in sync.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

SORT_MEMBERS_TEXT = (
    "package com.example.single;\n"
    "\n"
    "public class SortMembers {\n"
    "    void zebra() {\n"
    "    }\n"
    "\n"
    "    void apple() {\n"
    "    }\n"
    "\n"
    "    private int laterField = 2;\n"
    "    private int earlyField = 1;\n"
    "}\n"
)


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    repo = Path.cwd()
    root = (repo / "src/components/editor/workspace/__fixtures__/jdtls/projects/maven-single").resolve()
    if not (root / "pom.xml").is_file():
        raise FixtureSkip(
            "java sample project missing: maven-single pom.xml not found; "
            "the in-repo __fixtures__/jdtls/projects tree must be checked out"
        )
    destination = Path(ctx.case_dir) / "fixture-workspaces" / "sortable_single_root"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(root, destination, ignore=shutil.ignore_patterns("target", "build", ".gradle", ".git"))
    (destination / "src/main/java/com/example/single/SortMembers.java").write_text(
        SORT_MEMBERS_TEXT, encoding="utf-8", newline=""
    )
    values: dict[str, str] = getattr(ctx, "values")
    values["sortable_single_root"] = destination.resolve().as_posix()
