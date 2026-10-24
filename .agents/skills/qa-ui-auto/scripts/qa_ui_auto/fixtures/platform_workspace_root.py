"""Cross-mode platform workspace root for the Workspaces-mode QA cases.

The workspace-first shell needs a real directory to mount as a workspace root.
Browser preview exposes its virtual filesystem at ``/preview``; native runs need
an isolated host directory. This fixture hands both to step templates as
``${fixture.platform_workspace_root}`` so one case can run in browser *and*
native mode without branching its steps.

Unlike ``workspace_root`` this fixture does not skip browser mode: the VFS root
already exists and is writable through the ``workspace_*`` stubs.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

BROWSER_ROOT = "/preview"

SEED_FILES = {
    "README.md": "# platform workspace root\n\nSeeded by the qa-ui-auto platform_workspace_root fixture.\n",
    "src/index.ts": "export const platform = \"workspace\";\n",
}


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    values: dict[str, str] = getattr(ctx, "values")

    if mode != "native":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("platform_workspace_root needs a browser page")
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        page.evaluate(
            """async ({root, files}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              try { await vfs.vfsStat(root + '/src'); } catch { await vfs.vfsMkdir(root + '/src'); }
              for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
            }""",
            {"root": BROWSER_ROOT, "files": SEED_FILES},
        )
        values["platform_workspace_root"] = BROWSER_ROOT
        return

    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "platform-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-", dir=str(base)))
    for name, content in SEED_FILES.items():
        dest = root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content.encode("utf-8"))
    values["platform_workspace_root"] = root.as_posix()


def teardown(ctx: Any) -> None:
    # Keep the tree as failure evidence; report rotation prunes it.
    _ = ctx
