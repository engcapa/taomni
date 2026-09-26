"""Isolated ED-PARITY-005 project: browser B-005 and native F2-COMP-005."""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
from pathlib import Path
from typing import Any


POM = """<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity005</groupId>
  <artifactId>completion</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.12.0</version>
    </dependency>
  </dependencies>
</project>
"""
B0 = """package parity005;

public class Main {
    void sample() {
        Object typeProbe = null;
        new StringBuilder().append("seed");
    }
}
"""
B1 = """package parity005;

public class Main {
    void sample() {
        Stri;
    }
}
"""
M0 = B1.replace("Stri;", "StringUtiSuffix;")
BROWSER_ROOT = "/preview/parity005"


def _manifest(root: str, files: dict[str, str], case_id: str) -> dict[str, Any]:
    return {
        "case": case_id,
        "root": root,
        "files": {
            name: {"sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "bytes": len(text.encode("utf-8"))}
            for name, text in files.items()
        },
        "provider": "browser B-005 controlled" if root == BROWSER_ROOT else "real JDT LS required",
    }


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    case_id = str(getattr(ctx, "case_id", "TC-IDE-PARITY-005"))
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    if mode == "browser":
        root = BROWSER_ROOT
        files = {
            "pom.xml": POM,
            "src/main/java/parity005/Main.java": B1,
            "src/main/java/parity005/Mid.java": M0,
        }
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity005_completion needs a browser page")
        started = time.perf_counter()
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        navigation_ms = (time.perf_counter() - started) * 1000
        vfs_timing = page.evaluate(
            """async ({root, files}) => {
              const importStart = performance.now();
              const vfs = await import('/src/stubs/localVfs.ts');
              const importMs = performance.now() - importStart;
              const dirsStart = performance.now();
              const dirs = [root, root + '/src', root + '/src/main', root + '/src/main/java', root + '/src/main/java/parity005'];
              for (const dir of dirs) {
                try { await vfs.vfsStat(dir); }
                catch { await vfs.vfsMkdir(dir); }
              }
              const dirsMs = performance.now() - dirsStart;
              const filesStart = performance.now();
              for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
              const filesMs = performance.now() - filesStart;
              localStorage.setItem('taomni.qa.parity005.enabled', 'true');
              localStorage.setItem('taomni.qa.parity005.mode', JSON.stringify('normal'));
              localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
                id: 'qa-parity005', name: 'parity005', roots: [{ id: 'parity005', name: 'parity005', path: root, kind: 'folder' }],
                looseFiles: [], lastActiveFile: { kind: 'root', rootId: 'parity005', path: 'src/main/java/parity005/Main.java' },
                lastOpenedAt: 1756100000000, isGitRepo: false
              }]));
              return {importMs, dirsMs, filesMs};
            }""",
            {"root": root, "files": files},
        )
        timing = {"navigationMs": navigation_ms, "evaluateMs": (time.perf_counter() - started) * 1000 - navigation_ms, **vfs_timing}
    elif mode == "native":
        files = {"pom.xml": POM, "src/main/java/parity005/Main.java": B0}
        base = report_root / "native-workspaces"
        base.mkdir(parents=True, exist_ok=True)
        root_path = Path(tempfile.mkdtemp(prefix=f"{case_id}-", dir=base))
        root = root_path.as_posix()
        for name, text in files.items():
            target = root_path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text.encode("utf-8"))
    else:
        raise FixtureSkip(f"parity005_completion unsupported mode: {mode}")

    values: dict[str, str] = getattr(ctx, "values")
    values["parity005_root"] = root
    values["parity005_main"] = f"{root}/src/main/java/parity005/Main.java"
    values["parity005_mid"] = f"{root}/src/main/java/parity005/Mid.java"
    manifest = _manifest(root, files, case_id)
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "parity005-fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if mode == "browser":
        (case_dir / "parity005-fixture-timing.json").write_text(json.dumps(timing, indent=2) + "\n", encoding="utf-8")


def teardown(_ctx: Any) -> None:
    # The run-owned fixture and manifest remain with the report for byte review.
    return None
