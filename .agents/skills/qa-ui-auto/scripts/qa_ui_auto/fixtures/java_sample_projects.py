"""java_sample_projects: expose in-repo sample Maven/Gradle projects for native gates.

ED-PROJECT-002 (Maven) and ED-PROJECT-003 (Gradle) require `native`
evidence: the packaged Tauri app must ingest a REAL build project through
the production `useProjectFacts -> fetchProjectFacts -> workspace_ingest_*`
chain and render the ready badge. The native case seeds a recent workspace
whose root is the sample project directory, so this fixture only resolves
absolute on-disk paths and proves the descriptor files exist; it never
executes build tooling itself.

Exposes:
* ${fixture.maven_single_root}  - single-module Maven sample (pom.xml)
* ${fixture.gradle_single_root} - single-module Gradle sample (build.gradle)
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
from typing import Any

SAMPLES = {
    "maven_single_root": (
        Path("src/components/editor/workspace/__fixtures__/jdtls/projects/maven-single"),
        "pom.xml",
    ),
    "gradle_single_root": (
        Path("src/components/editor/workspace/__fixtures__/jdtls/projects/gradle-single"),
        "build.gradle",
    ),
}

RECOVERY_PRE_IMAGE = "recovery-pre-image\n"
RECOVERY_POST_IMAGE = "recovery-post-image\n"
RECOVERY_RELATIVE_PATH = "src/main/resources/recovery.txt"
RECOVERY_ACTION_ID = "qa-recovery-rename"
RECOVERY_TRANSACTION_ID = "qa-recovery-transaction"


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result


def _workspace_id(root: Path) -> str:
    normalized = root.as_posix().rstrip("/")
    identity = json.dumps(
        {
            "roots": [{"path": normalized, "kind": "folder"}],
            "looseFiles": [],
        },
        separators=(",", ":"),
    )
    value = 0
    for char in identity:
        value = (value * 31 + ord(char)) & 0xFFFFFFFF
        if value & 0x80000000:
            value -= 0x100000000
    return f"workspace-{_base36(abs(value))}"


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    repo = Path.cwd()
    values: dict[str, str] = getattr(ctx, "values")
    for key, (rel, marker) in SAMPLES.items():
        root = (repo / rel).resolve()
        if not (root / marker).is_file():
            raise FixtureSkip(
                f"java sample project missing: {root / marker} not found; "
                "the in-repo __fixtures__/jdtls/projects tree must be checked out"
            )
        # Native create/rename/undo tests must not mutate the checkout's samples.
        destination = Path(ctx.case_dir) / "fixture-workspaces" / key
        if any(path.is_symlink() for path in root.rglob("*")):
            raise FixtureSkip(f"sample contains symlinks; cannot isolate workspace: {root}")
        shutil.copytree(root, destination, ignore=shutil.ignore_patterns("target", "build", ".gradle", ".git"))
        values[key] = destination.resolve().as_posix()

    recovery_root = Path(values["maven_single_root"])
    recovery_path = recovery_root / RECOVERY_RELATIVE_PATH
    recovery_path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the fixture's preimage explicit before leaving the host file at the
    # postimage expected by the pending journal. This makes the native case's
    # recovery contract independently checkable from the app's state.
    recovery_path.write_bytes(RECOVERY_PRE_IMAGE.encode("utf-8"))
    recovery_path.write_bytes(RECOVERY_POST_IMAGE.encode("utf-8"))
    workspace_id = _workspace_id(recovery_root)
    recovery_id = "ref-rec-" + hashlib.sha256(
        f"{workspace_id}:{RECOVERY_TRANSACTION_ID}:{RECOVERY_ACTION_ID}".encode("utf-8")
    ).hexdigest()[:16]
    values.update({
        "maven_recovery_root": recovery_root.resolve().as_posix(),
        "maven_recovery_file": recovery_path.resolve().as_posix(),
        "maven_recovery_workspace_id": workspace_id,
        "maven_recovery_recovery_id": recovery_id,
        "maven_recovery_pre_sha256": hashlib.sha256(RECOVERY_PRE_IMAGE.encode("utf-8")).hexdigest(),
        "maven_recovery_post_sha256": hashlib.sha256(RECOVERY_POST_IMAGE.encode("utf-8")).hexdigest(),
    })
