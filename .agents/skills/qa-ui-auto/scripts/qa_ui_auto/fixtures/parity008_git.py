"""ED-PARITY-008 F3 fixture: two isolated local Git repositories.

Browser mode seeds the controlled `src/stubs/parity008Git.ts` provider and the
worktree bytes in the browser VFS; it can prove renderer routing only.
Native mode creates two real repositories (same bytes as the IDEA reference
`prepare.py`) in the OS temp directory — never inside a checkout, because
workspace Git-root detection walks up and would adopt the enclosing repository
as a third, mutable repo. It records `.git/index`/ref/worktree hashes so
`assert_file_sha256` steps can prove zero Git writes, then gives
`repo-b/stable.txt` a newer mtime with unchanged bytes: the stale index stat
entry that makes a plain `git status` rewrite `.git/index`.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import subprocess
import tempfile
from pathlib import Path
from typing import Any


BROWSER_ROOT = "/preview/parity008"
WORKTREE = {
    "repo-a/same.txt": "repo-a WORKTREE\nshared line\n",
    "repo-a/stable.txt": "stable\n",
    "repo-a/untracked.txt": "untracked A\n",
    "repo-b/same.txt": "repo-b WORKTREE\nshared line\n",
    "repo-b/stable.txt": "stable\n",
}


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return result.stdout.strip()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _enclosing_repo(path: Path) -> Path | None:
    return next((d for d in [path, *path.parents] if (d / ".git").exists()), None)


def create_native_fixture(parent: Path) -> tuple[Path, dict[str, Any]]:
    parent.mkdir(parents=True, exist_ok=True)
    enclosing = _enclosing_repo(parent.resolve())
    if enclosing is not None:
        raise RuntimeError(f"parity008_git: fixture parent {parent} is inside Git repository {enclosing}")
    workspace = Path(tempfile.mkdtemp(prefix="parity008-", dir=str(parent))).resolve()
    manifest: dict[str, Any] = {"workspace": workspace.as_posix(), "repos": {}}
    for name in ("repo-a", "repo-b"):
        repo = workspace / name
        repo.mkdir()
        _git(repo, "init", "-b", "main")
        _git(repo, "config", "user.name", "Parity Fixture")
        _git(repo, "config", "user.email", "fixture@example.invalid")
        _git(repo, "config", "core.autocrlf", "false")
        _git(repo, "config", "commit.gpgsign", "false")
        (repo / "same.txt").write_bytes(f"{name} HEAD\nshared line\n".encode())
        (repo / "stable.txt").write_bytes(b"stable\n")
        _git(repo, "add", ".")
        _git(repo, "commit", "--no-gpg-sign", "-m", "fixture baseline")
        if name == "repo-a":
            (repo / "same.txt").write_bytes(b"repo-a INDEX\nshared line\n")
            _git(repo, "add", "same.txt")
            (repo / "same.txt").write_bytes(b"repo-a WORKTREE\nshared line\n")
            (repo / "untracked.txt").write_bytes(b"untracked A\n")
        else:
            (repo / "same.txt").write_bytes(b"repo-b WORKTREE\nshared line\n")
        manifest["repos"][name] = {
            "head": _git(repo, "rev-parse", "HEAD"),
            "status": _git(repo, "status", "--porcelain=v1").splitlines(),
            "indexSha256": _sha256(repo / ".git" / "index"),
            "headRefSha256": _sha256(repo / ".git" / "HEAD"),
            "mainRefSha256": _sha256(repo / ".git" / "refs" / "heads" / "main"),
            "worktreeSha256": _sha256(repo / "same.txt"),
            "stableSha256": _sha256(repo / "stable.txt"),
        }
    # Stale stat entry: same bytes, newer mtime (after the index was hashed).
    stable = workspace / "repo-b" / "stable.txt"
    later = time.time() + 5
    os.utime(stable, (later, later))
    manifest["staleStatPath"] = stable.as_posix()
    return workspace, manifest


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    values: dict[str, str] = getattr(ctx, "values")
    if mode == "browser":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity008_git needs a browser page")
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        page.evaluate(
            """async ({root, files}) => {
              const vfs = await import('/src/stubs/localVfs.ts');
              for (const dir of [root, root + '/repo-a', root + '/repo-b']) {
                try { await vfs.vfsStat(dir); } catch { await vfs.vfsMkdir(dir); }
              }
              for (const [name, text] of Object.entries(files)) await vfs.vfsWriteText(root + '/' + name, text);
              localStorage.setItem('taomni.qa.parity008.enabled', 'true');
              localStorage.removeItem('taomni.qa.parity008.holdPairRepo');
              localStorage.setItem('taomni.git.workspace.changes.tree', 'flat');
              localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
                id: 'qa-parity008', name: 'parity008', roots: [{ id: 'parity008', name: 'parity008', path: root, kind: 'folder' }],
                looseFiles: [], lastActiveFile: { kind: 'root', rootId: 'parity008', path: 'repo-a/same.txt' },
                lastOpenedAt: 1756100000000, isGitRepo: false
              }]));
            }""",
            {"root": BROWSER_ROOT, "files": WORKTREE},
        )
        values["parity008_root"] = BROWSER_ROOT
        manifest: dict[str, Any] = {"workspace": BROWSER_ROOT, "provider": "browser parity008 controlled", "files": WORKTREE}
    elif mode == "native":
        workspace, manifest = create_native_fixture(Path(tempfile.gettempdir()) / "taomni-qa-parity008")
        values["parity008_root"] = workspace.as_posix()
        for name in ("repo-a", "repo-b"):
            key = name.replace("-", "_")
            repo = manifest["repos"][name]
            values[f"parity008_{key}"] = (workspace / name).as_posix()
            values[f"parity008_{key}_head"] = repo["head"]
            values[f"parity008_{key}_head7"] = repo["head"][:7]
            values[f"parity008_{key}_index_sha256"] = repo["indexSha256"]
            values[f"parity008_{key}_main_sha256"] = repo["mainRefSha256"]
            values[f"parity008_{key}_worktree_sha256"] = repo["worktreeSha256"]
            values[f"parity008_{key}_stable_sha256"] = repo["stableSha256"]
    else:
        raise FixtureSkip(f"parity008_git unsupported mode: {mode}")
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "parity008-fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def teardown(_ctx: Any) -> None:
    # Retained with the report so the Git hashes can be re-audited.
    return None
