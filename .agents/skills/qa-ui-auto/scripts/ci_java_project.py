"""Prepare the pinned public Java checkout only for real-project navigation."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import tarfile

import yaml

from ci_maven_warmup import warm_maven
from ci_toolchains import download
from qa_ui_auto.ci import write_json


def prepare(root: Path) -> Path:
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    spec = yaml.safe_load(Path("qa-ui-auto-tests/ci/toolchains.yaml").read_text(encoding="utf-8"))["java-real-project"]
    archive = root / "source.tar.gz"
    download(spec, archive)
    extracted = root / "source"
    extracted.mkdir()
    with tarfile.open(archive) as bundle:
        # This fixture consumes source files, never links or device entries.
        if any(not (item.isfile() or item.isdir()) for item in bundle.getmembers()):
            raise RuntimeError("Public Java source archive contains non-file entries")
        bundle.extractall(extracted, filter="data")
    project = extracted / ("commons-lang-" + spec["revision"])
    if not (project / "pom.xml").is_file():
        raise RuntimeError("Public Java archive lacks the pinned Maven project")
    mvn = shutil.which("mvn")
    if not mvn:
        raise RuntimeError("Public Java project preparation requires Maven")
    # Compile upstream sources unmodified and resolve the real Maven model.
    warm_maven([mvn, "-B", "-q", "-DskipTests", "-Dcheckstyle.skip", "compile"], project, root / "maven")
    write_json(root / "project.json", {**spec, "path": project.as_posix(), "compiled": True})
    os.environ["QA_JAVA_PROJECT_ROOT"] = project.as_posix()
    return project
