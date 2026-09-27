"""Isolated ED-PARITY-006 fixture: F1-REPL-006 scope/mask/replace/conflict files."""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
from pathlib import Path
from typing import Any


A_INITIAL = "alpha token one\nbeta token two\n"
B_INITIAL = "gamma token three\n"
C_INITIAL = "token in markdown\n"
D_INITIAL = "token outside scope\n"

A_COMMITTED = "alpha coin one\nbeta token two\n"
B_COMMITTED = "gamma coin three\n"
B_CHANGED = "gamma token changed\n"

BROWSER_ROOT = "/preview/parity006"

FILES_INITIAL = {
    "src/a.txt": A_INITIAL,
    "src/b.txt": B_INITIAL,
    "src/c.md": C_INITIAL,
    "other/d.txt": D_INITIAL,
}


def _manifest(root: str, files: dict[str, str], case_id: str) -> dict[str, Any]:
    return {
        "case": case_id,
        "root": root,
        "files": {
            name: {
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "bytes": len(text.encode("utf-8")),
            }
            for name, text in files.items()
        },
        "committed": {
            "src/a.txt": hashlib.sha256(A_COMMITTED.encode("utf-8")).hexdigest(),
            "src/b.txt": hashlib.sha256(B_COMMITTED.encode("utf-8")).hexdigest(),
        },
        "changed": {
            "src/b.txt": hashlib.sha256(B_CHANGED.encode("utf-8")).hexdigest(),
        },
    }


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    case_id = str(getattr(ctx, "case_id", "TC-IDE-PARITY-006"))
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()

    if mode == "browser":
        root = BROWSER_ROOT
        files = FILES_INITIAL
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity006_replace needs a browser page")
        started = time.perf_counter()
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        navigation_ms = (time.perf_counter() - started) * 1000
        vfs_timing = page.evaluate(
            """async ({root, files}) => {
              const importStart = performance.now();
              const vfs = await import('/src/stubs/localVfs.ts');
              const importMs = performance.now() - importStart;
              const dirsStart = performance.now();
              const dirs = [root, root + '/src', root + '/other'];
              for (const dir of dirs) {
                try { await vfs.vfsStat(dir); }
                catch { await vfs.vfsMkdir(dir); }
              }
              const dirsMs = performance.now() - dirsStart;
              const filesStart = performance.now();
              for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
              const filesMs = performance.now() - filesStart;
              localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
                id: 'qa-parity006', name: 'parity006', roots: [{ id: 'parity006', name: 'parity006', path: root, kind: 'folder' }],
                looseFiles: [], lastActiveFile: { kind: 'root', rootId: 'parity006', path: 'src/a.txt' },
                lastOpenedAt: 1756200000000, isGitRepo: false
              }]));
              return {importMs, dirsMs, filesMs};
            }""",
            {"root": root, "files": files},
        )
        timing = {
            "navigationMs": navigation_ms,
            "evaluateMs": (time.perf_counter() - started) * 1000 - navigation_ms,
            **vfs_timing,
        }
    elif mode == "native":
        files = FILES_INITIAL
        base = report_root / "native-workspaces"
        base.mkdir(parents=True, exist_ok=True)
        root_path = Path(tempfile.mkdtemp(prefix=f"{case_id}-", dir=base))
        root = root_path.as_posix()
        for name, text in files.items():
            target = root_path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text.encode("utf-8"))
    else:
        raise FixtureSkip(f"parity006_replace unsupported mode: {mode}")

    values: dict[str, str] = getattr(ctx, "values")
    values["parity006_root"] = root
    values["parity006_a"] = f"{root}/src/a.txt"
    values["parity006_b"] = f"{root}/src/b.txt"
    values["parity006_c"] = f"{root}/src/c.md"
    values["parity006_d"] = f"{root}/other/d.txt"
    values["parity006_sha_initial_a"] = hashlib.sha256(A_INITIAL.encode("utf-8")).hexdigest()
    values["parity006_sha_initial_b"] = hashlib.sha256(B_INITIAL.encode("utf-8")).hexdigest()
    values["parity006_sha_initial_c"] = hashlib.sha256(C_INITIAL.encode("utf-8")).hexdigest()
    values["parity006_sha_initial_d"] = hashlib.sha256(D_INITIAL.encode("utf-8")).hexdigest()
    values["parity006_sha_commit_a"] = hashlib.sha256(A_COMMITTED.encode("utf-8")).hexdigest()
    values["parity006_sha_commit_b"] = hashlib.sha256(B_COMMITTED.encode("utf-8")).hexdigest()
    values["parity006_sha_changed_b"] = hashlib.sha256(B_CHANGED.encode("utf-8")).hexdigest()

    manifest = _manifest(root, files, case_id)
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "parity006-fixture.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    if mode == "browser":
        (case_dir / "parity006-fixture-timing.json").write_text(
            json.dumps(timing, indent=2) + "\n", encoding="utf-8"
        )


def teardown(_ctx: Any) -> None:
    return None
