"""ED-PARITY-006 F1-REPL-006 scope/mask/replace fixture."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


BROWSER_ROOT = "/preview/parity006"
FILES = {
    "src/a.txt": "alpha token one\nbeta token two\n",
    "src/b.txt": "gamma token three\n",
    "src/c.md": "token in markdown\n",
    "other/d.txt": "token outside scope\n",
}
COMMITTED_FILES = {
    **FILES,
    "src/a.txt": "alpha coin one\nbeta token two\n",
    "src/b.txt": "gamma coin three\n",
}


def _manifest(root: str, case_id: str) -> dict[str, Any]:
    def entry(text: str) -> dict[str, Any]:
        raw = text.encode("utf-8")
        return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

    return {
        "case": case_id,
        "root": root,
        "files": {
            path: {"initial": entry(FILES[path]), "committed": entry(COMMITTED_FILES[path])}
            for path in FILES
        },
        "provider": "browser VFS controlled" if root == BROWSER_ROOT else "real host disk",
    }


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    case_id = str(getattr(ctx, "case_id", "TC-IDE-PARITY-006"))
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()

    if mode == "browser":
        root = BROWSER_ROOT
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity006_replace needs a browser page")
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        page.evaluate(
            """async ({root, files}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              for (const dir of [root, `${root}/src`, `${root}/other`]) {
                try { await vfs.vfsStat(dir); } catch { await vfs.vfsMkdir(dir); }
              }
              for (const [name, text] of Object.entries(files)) {
                await vfs.vfsWriteText(`${root}/${name}`, text);
              }
              localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
                id: 'qa-parity006', name: 'parity006',
                roots: [{ id: 'parity006', name: 'parity006', path: root, kind: 'folder' }],
                looseFiles: [],
                lastActiveFile: { kind: 'root', rootId: 'parity006', path: 'src/a.txt' },
                lastOpenedAt: 1756100000000, isGitRepo: false
              }]));
            }""",
            {"root": root, "files": FILES},
        )
    elif mode == "native":
        base = report_root / "native-workspaces"
        base.mkdir(parents=True, exist_ok=True)
        root_path = Path(tempfile.mkdtemp(prefix=f"{case_id}-", dir=base))
        root = root_path.as_posix()
        for relative, text in FILES.items():
            target = root_path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text.encode("utf-8"))
    else:
        raise FixtureSkip(f"parity006_replace unsupported mode: {mode}")

    values: dict[str, str] = getattr(ctx, "values")
    values["parity006_root"] = root
    for relative in FILES:
        key = relative.replace("/", "_").replace(".", "_")
        values[f"parity006_{key}"] = f"{root}/{relative}"

    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "parity006-fixture.json").write_text(
        json.dumps(_manifest(root, case_id), indent=2) + "\n",
        encoding="utf-8",
    )


def teardown(_ctx: Any) -> None:
    return None
