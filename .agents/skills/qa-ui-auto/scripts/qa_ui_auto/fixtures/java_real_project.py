"""Read-only Commons Lang navigation inputs; local omission is an explicit skip."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


SOURCE = "src/main/java/org/apache/commons/lang3/tuple/ImmutablePair.java"
TARGET = "src/main/java/org/apache/commons/lang3/tuple/Pair.java"


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    raw = ctx.env.get("QA_JAVA_PROJECT_ROOT", "").strip()
    if not raw:
        if ctx.env.get("GITHUB_ACTIONS") == "true":
            raise RuntimeError("Hosted Java project was not prepared: QA_JAVA_PROJECT_ROOT is unset")
        raise FixtureSkip("QA_JAVA_PROJECT_ROOT is unset; provide a Commons Lang 3.17.0 checkout")
    root = Path(raw).expanduser()
    if not root.is_absolute():
        raise RuntimeError("QA_JAVA_PROJECT_ROOT must be an absolute project path")
    root = root.resolve()
    paths = {"java_source": root / SOURCE, "java_target": root / TARGET, "java_pom": root / "pom.xml"}
    for name, path in paths.items():
        if not path.is_file():
            raise RuntimeError(f"Invalid Commons Lang project: missing {path}")
        ctx.values[name] = path.as_posix()
        ctx.values[name + "_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    source = paths["java_source"].read_text(encoding="utf-8")
    declaration = "public final L left;"
    if any(token not in source for token in (declaration, "return left;", "extends Pair<L, R>", "import java.util.Map;")):
        raise RuntimeError("Commons Lang checkout does not match the navigation scenario")
    for key, token, advance in (
        ("java_field_cursor", declaration, len("public final L ")),
        ("java_field_reference_cursor", "return left;", 8),
        ("java_pair_reference_cursor", "extends Pair<L, R>", 10),
        ("java_jdk_reference_cursor", "import java.util.Map;", 18),
    ):
        offset = source.index(token) + advance
        line = source.count("\n", 0, offset) + 1
        column = offset - source.rfind("\n", 0, offset)
        ctx.values[key] = f"{line}:{column}"
    ctx.values["java_project_root"] = root.as_posix()
    ctx.values["java_recent_workspace"] = json.dumps([{
        "id": "qa-real-java-definition", "name": "Apache Commons Lang",
        "roots": [{"id": "commons-lang", "name": "commons-lang", "path": root.as_posix(), "kind": "folder"}],
        "looseFiles": [], "lastActiveFile": {"kind": "root", "rootId": "commons-lang", "path": SOURCE},
        "lastOpenedAt": 1789692000000, "isGitRepo": False,
    }])
    Path(ctx.case_dir, "java-project-inputs.json").write_text(json.dumps({
        key: value for key, value in ctx.values.items() if key != "java_recent_workspace"
    }, indent=2) + "\n", encoding="utf-8")
