"""ED-PARITY-009 F2 fixture: the IDEA `StructuralTarget.java` sample.

Browser mode writes the file to the VFS and enables the controlled Lezer
matcher in `src/stubs/parity009StructuralSearch.ts` (renderer lifecycle only).
Native mode writes the byte-identical file to a disk workspace searched by the
real tree-sitter backend, plus a separate bulk workspace large enough for a
cancellation to land while the backend is still parsing.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any


BROWSER_ROOT = "/preview/parity009"
TARGET_PATH = "src/StructuralTarget.java"
# Byte-identical to qa-ui-auto-report/idea-reference/p1-remaining/run-20260927/
# fixture-before.json["java"] (sha256 8fea975f…ec23).
TARGET = (
    "public class StructuralTarget {\n"
    "  void run() {\n"
    "    System.out.println(\"alpha\");\n"
    "    System.out.println(42);\n"
    "    System.out.println(\n"
    "        \"beta\");\n"
    "    System.out.print(\"not println\");\n"
    "    // System.out.println(\"comment\");\n"
    "    String text = \"System.out.println(\\\"string\\\");\";\n"
    "    System.err.println(\"stderr\");\n"
    "  }\n"
    "}\n"
)
TARGET_SHA256 = "8fea975fe2c16a584a0538981201f8c567b9c511b9a7ef4950b65500c0b6ec23"
BULK_FILES = 1500
BULK_METHODS = 120


def _bulk_source(index: int) -> str:
    body = "\n".join(
        f"  int m{m}(int v) {{ int x = v * {m} + {index}; if (x > {m}) {{ x -= {m}; }} return x; }}"
        for m in range(BULK_METHODS)
    )
    return f"package bulk;\n\npublic class Bulk{index} {{\n{body}\n}}\n"


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    if hashlib.sha256(TARGET.encode()).hexdigest() != TARGET_SHA256:
        raise RuntimeError("parity009_ssr: fixture text drifted from the IDEA reference bytes")
    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    values: dict[str, str] = getattr(ctx, "values")
    values["parity009_target_sha256"] = TARGET_SHA256
    if mode == "browser":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity009_ssr needs a browser page")
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        page.evaluate(
            """async ({root, path, text}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              for (const dir of [root, root + '/src']) {
                try { await vfs.vfsStat(dir); } catch { await vfs.vfsMkdir(dir); }
              }
              await vfs.vfsWriteText(root + '/' + path, text);
              await vfs.vfsWriteText(root + '/Other.java', 'class Other {}');
              localStorage.setItem('taomni.qa.parity009.enabled', 'true');
              localStorage.setItem('taomni.qa.parity009.mode', 'normal');
              localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
                id: 'qa-parity009', name: 'parity009', roots: [{ id: 'parity009', name: 'parity009', path: root, kind: 'folder' }],
                looseFiles: [], lastActiveFile: { kind: 'root', rootId: 'parity009', path },
                lastOpenedAt: 1756100000000, isGitRepo: false
              }]));
            }""",
            {"root": BROWSER_ROOT, "path": TARGET_PATH, "text": TARGET},
        )
        values["parity009_root"] = BROWSER_ROOT
    elif mode == "native":
        base = report_root / "native-workspaces"
        base.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="parity009-", dir=str(base))).resolve()
        target = root / TARGET_PATH
        target.parent.mkdir(parents=True)
        target.write_bytes(TARGET.encode())
        (root / 'Other.java').write_text('class Other {}', encoding='utf-8')
        errors = Path(tempfile.mkdtemp(prefix="parity009-encoding-", dir=str(base))).resolve()
        unsupported = errors / "Legacy.java"
        unsupported.write_bytes(b'\xff\xfe' + TARGET.encode('utf-16-le'))
        values["parity009_encoding_root"] = errors.as_posix()
        values["parity009_encoding_file"] = unsupported.as_posix()
        values["parity009_encoding_sha256"] = hashlib.sha256(unsupported.read_bytes()).hexdigest()
        bulk = Path(tempfile.mkdtemp(prefix="parity009-bulk-", dir=str(base))).resolve()
        (bulk / "bulk").mkdir()
        for index in range(BULK_FILES):
            (bulk / "bulk" / f"Bulk{index}.java").write_bytes(_bulk_source(index).encode())
        values["parity009_root"] = root.as_posix()
        values["parity009_target"] = target.as_posix()
        values["parity009_bulk_root"] = bulk.as_posix()
    else:
        raise FixtureSkip(f"parity009_ssr unsupported mode: {mode}")
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "root": values["parity009_root"],
        "target": TARGET_PATH,
        "sha256": TARGET_SHA256,
        "bytes": len(TARGET.encode()),
        "bulkRoot": values.get("parity009_bulk_root"),
        "provider": "browser lezer (QA fixture)" if mode == "browser" else "native tree-sitter-java",
    }
    (case_dir / "parity009-fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def teardown(_ctx: Any) -> None:
    return None
