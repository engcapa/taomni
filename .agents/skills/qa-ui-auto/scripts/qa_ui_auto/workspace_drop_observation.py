"""Read-only byte/tree oracle for the isolated workspace_drop_import fixture.

A DOM absence alone cannot prove a refused drop did nothing. Compare the entire
source and both roots, including empty directories, against independent hashes.
Browser reads VFS only; native re-reads real host bytes without any app IPC.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .steps import StepError

STATES = {"seeded", "directory", "recovered", "root"}
READ_VFS = """async (base) => {
  const vfs = await import('/src/stubs/localVfs.ts');
  const files = {}, directories = [''];
  async function walk(relative) {
    for (const entry of await vfs.vfsList(base + (relative ? '/' + relative : ''))) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.fileType === 'dir') {
        directories.push(name);
        await walk(name);
      } else {
        const bytes = await vfs.vfsReadBytes(base + '/' + name);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        files[name] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      }
    }
  }
  await walk('');
  return {files, directories: directories.sort()};
}"""


def host_snapshot(base: Path) -> dict[str, Any]:
    if not base.is_dir() or base.is_symlink():
        raise StepError("assert_workspace_drop_import: fixture base missing or symlinked")
    files: dict[str, str] = {}
    directories = [""]
    for path in sorted(base.rglob("*")):
        name = path.relative_to(base).as_posix()
        if path.is_symlink():
            raise StepError(f"assert_workspace_drop_import: unexpected symlink {name}")
        if path.is_dir():
            directories.append(name)
        elif path.is_file():
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            raise StepError(f"assert_workspace_drop_import: unexpected special file {name}")
    return {"files": files, "directories": sorted(directories)}


def run(ctx: Any, args: Any, *, mode: str) -> str:
    state = args.get("state") if isinstance(args, dict) and set(args) == {"state"} else None
    if not isinstance(state, str) or state not in STATES:
        raise StepError("assert_workspace_drop_import: expected {state: seeded|directory|recovered|root}")
    if getattr(ctx, "dry_run", False):
        return "dry-run only; no filesystem observation"
    record = {"mode": mode, "state": state, "physicalOsGesture": False,
              "observation": "host-byte-sha256" if mode == "native" else "browser-vfs-sha256"}
    try:
        manifest = json.loads((ctx.case_dir / "workspace-drop-import-fixture.json").read_text(encoding="utf-8"))
        if manifest.get("schema") != "qa.workspace-drop-import.v1" or manifest.get("mode") != mode:
            raise StepError("assert_workspace_drop_import: fixture manifest schema/mode differs")
        base = manifest["base"]
        expected = manifest["states"][state]
        if mode == "native":
            path = Path(base).resolve()
            if not path.is_relative_to(ctx.case_dir.parent.resolve()) or not path.name.startswith("workspace-drop-import-"):
                raise StepError("assert_workspace_drop_import: native tree is outside the retained fixture")
            observe = lambda: host_snapshot(path)
        else:
            if not base.startswith("/preview/workspace-drop-import-"):
                raise StepError("assert_workspace_drop_import: unexpected VFS fixture base")
            observe = lambda: ctx.page.evaluate(READ_VFS, base)
        # A refused drop must remain a no-op, not just win one immediate read
        # before an asynchronous write. No assertion polls through a mismatch.
        started = time.monotonic()
        samples = []
        record.update(expected=expected, samples=samples, quietMs=500)
        while True:
            observed = observe()
            elapsed = time.monotonic() - started
            samples.append({"elapsedMs": elapsed * 1000, "observed": observed})
            if observed != expected:
                raise StepError(f"assert_workspace_drop_import: {state} source/target bytes or directory set differ; see retained observation")
            if elapsed >= 0.5:
                break
            time.sleep(min(0.1, 0.5 - elapsed))
        record["passed"] = True
        return f"{mode} exact source + root1 + root2 SHA-256/empty-directory snapshot: {state}"
    except Exception as error:
        record.update(passed=False, error=str(error))
        raise
    finally:
        with (ctx.case_dir / "workspace-drop-import-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def native(ctx: Any, args: Any) -> str:
    return run(ctx, args, mode="native")
