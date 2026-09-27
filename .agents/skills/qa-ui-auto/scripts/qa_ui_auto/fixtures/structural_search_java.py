"""Java Structural Search fixture for ED-PARITY-009."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


BROWSER_ROOT = "/preview/structural-search"
STRUCTURAL_TARGET = '''class StructuralTarget {
  void run() {
    System.out.println("one");
    System.out.println(42);
    System.out.println(
      7
    );
    // System.out.println(99);
    String fake = "System.out.println(100);";
    System.out.print(1);
    System.err.println(2);
  }
}
'''


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _seed_browser(page: Any, base_url: str) -> None:
    page.goto(base_url, wait_until="commit")
    page.evaluate(
        """async ({root, text}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          try { await vfs.vfsStat(root); } catch { await vfs.vfsMkdir(root); }
          await vfs.vfsWriteText(`${root}/StructuralTarget.java`, text);
          localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
            id: 'qa-structural-search', name: 'structural-search',
            roots: [{ id: 'structural-search', name: 'structural-search', path: root, kind: 'folder' }],
            looseFiles: [],
            lastActiveFile: { kind: 'root', rootId: 'structural-search', path: 'StructuralTarget.java' },
            lastOpenedAt: 1756100000000, isGitRepo: false
          }]));
        }""",
        {"root": BROWSER_ROOT, "text": STRUCTURAL_TARGET},
    )


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    case_id = str(getattr(ctx, "case_id", "TC-IDE-PARITY-009"))
    if mode == "browser":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("structural_search_java needs a browser page")
        _seed_browser(page, cfg["app"]["base_url"])
        root = BROWSER_ROOT
    elif mode == "native":
        native_parent = report_root / "native-workspaces"
        native_parent.mkdir(parents=True, exist_ok=True)
        root_path = Path(tempfile.mkdtemp(
            prefix=f"{case_id}-", dir=str(native_parent),
        )).resolve()
        root_path.mkdir(parents=True, exist_ok=True)
        target = root_path / "StructuralTarget.java"
        target.write_bytes(STRUCTURAL_TARGET.encode("utf-8"))
        root = root_path.as_posix()
    else:
        raise FixtureSkip(f"structural_search_java unsupported mode: {mode}")

    values: dict[str, str] = getattr(ctx, "values")
    values["structural_search_root"] = root
    values["structural_search_file"] = f"{root}/StructuralTarget.java"
    values["structural_search_sha256"] = _sha256(STRUCTURAL_TARGET)
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "structural-search-fixture.json").write_text(
        json.dumps({
            "case": case_id,
            "mode": mode,
            "root": root,
            "file": "StructuralTarget.java",
            "sha256": _sha256(STRUCTURAL_TARGET),
            "expected": {"all": 3, "text42": 1, "text999": 0},
        }, indent=2) + "\n",
        encoding="utf-8",
    )


def teardown(_ctx: Any) -> None:
    return None
