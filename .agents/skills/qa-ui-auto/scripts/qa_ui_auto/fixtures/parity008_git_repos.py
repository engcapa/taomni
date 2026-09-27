"""ED-PARITY-008 F3 fixture with two isolated repositories.

Browser mode provisions two VFS roots so renderer routing can be exercised.
Native mode creates two real repositories with distinct HEAD/index/worktree
states and records their hashes beside the run report.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


BROWSER_ROOT = "/preview/parity008"
REPOS = {
    "a": {
        "name": "repo-a",
        "head": "repo-a HEAD\n",
        "index": "repo-a INDEX\n",
        "worktree": "repo-a WORKTREE\n",
    },
    "b": {
        "name": "repo-b",
        "head": "repo-b HEAD\n",
        "index": "repo-b INDEX\n",
        "worktree": "repo-b WORKTREE\n",
    },
}


def _run(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout.strip()


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _create_native_repo(parent: Path, key: str) -> tuple[Path, dict[str, Any]]:
    spec = REPOS[key]
    repo = Path(tempfile.mkdtemp(prefix=f"parity008-{key}-", dir=str(parent))).resolve()
    try:
        _run(repo, "init", "--initial-branch=main")
    except subprocess.CalledProcessError:
        _run(repo, "init")
        _run(repo, "checkout", "-b", "main")
    _run(repo, "config", "user.name", "Taomni QA")
    _run(repo, "config", "user.email", "taomni-qa@example.invalid")
    _run(repo, "config", "core.autocrlf", "false")
    _run(repo, "config", "commit.gpgsign", "false")
    (repo / "same.txt").write_bytes(spec["head"].encode("utf-8"))
    head_oid = _run(repo, "add", "same.txt") or ""
    _run(repo, "commit", "--no-gpg-sign", "-m", f"{spec['name']} baseline")
    head_oid = _run(repo, "rev-parse", "HEAD")
    if key == "a":
        (repo / "same.txt").write_bytes(spec["index"].encode("utf-8"))
        _run(repo, "add", "same.txt")
    (repo / "same.txt").write_bytes(spec["worktree"].encode("utf-8"))
    if key == "a":
        (repo / "untracked.txt").write_text(f"{spec['name']} untracked\n", encoding="utf-8", newline="")
    status = _run(repo, "status", "--porcelain=v1").splitlines()
    manifest = {
        "repo": repo.as_posix(),
        "name": spec["name"],
        "branch": "main",
        "head": {"oid": head_oid, "text": spec["head"], "sha256": _sha256(spec["head"])},
        "index": {"text": spec["index"] if key == "a" else spec["head"], "sha256": _sha256(spec["index"] if key == "a" else spec["head"])},
        "worktree": {"text": spec["worktree"], "sha256": _sha256(spec["worktree"])},
        "statusPorcelain": status,
        "indexFileSha256": hashlib.sha256((repo / ".git" / "index").read_bytes()).hexdigest(),
        "headRefSha256": hashlib.sha256((repo / ".git" / "refs" / "heads" / "main").read_bytes()).hexdigest(),
    }
    return repo, manifest


def _write_browser_fixture(page: Any, base_url: str) -> None:
    files = {
        f"{BROWSER_ROOT}/repo-a/same.txt": REPOS["a"]["worktree"],
        f"{BROWSER_ROOT}/repo-a/untracked.txt": "repo-a untracked\n",
        f"{BROWSER_ROOT}/repo-b/same.txt": REPOS["b"]["worktree"],
    }
    page.goto(base_url, wait_until="commit")
    page.evaluate(
        """async ({root, files}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          for (const dir of [root, `${root}/repo-a`, `${root}/repo-b`]) {
            try { await vfs.vfsStat(dir); } catch { await vfs.vfsMkdir(dir); }
          }
          for (const [path, text] of Object.entries(files)) await vfs.vfsWriteText(path, text);
          localStorage.setItem('taomni.recentWorkspaces.v1', JSON.stringify([{
            id: 'qa-parity008', name: 'parity008',
            roots: [
              { id: 'parity008-a', name: 'repo-a', path: `${root}/repo-a`, kind: 'git' },
              { id: 'parity008-b', name: 'repo-b', path: `${root}/repo-b`, kind: 'git' }
            ],
            looseFiles: [], lastOpenedAt: 1756100000000,
            lastActiveFile: { kind: 'root', rootId: 'parity008-a', path: 'same.txt' },
            isGitRepo: true
          }]));
        }""",
        {"root": BROWSER_ROOT, "files": files},
    )


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    case_id = str(getattr(ctx, "case_id", "TC-IDE-PARITY-008"))
    manifests: dict[str, dict[str, Any]] = {}

    if mode == "browser":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("parity008_git_repos needs a browser page")
        _write_browser_fixture(page, cfg["app"]["base_url"])
        root = BROWSER_ROOT
        repo_paths = {key: f"{root}/{spec['name']}" for key, spec in REPOS.items()}
    elif mode == "native":
        try:
            subprocess.run(["git", "--version"], check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError) as error:
            raise FixtureSkip(f"parity008_git_repos requires git: {error}") from error
        parent = report_root / "native-workspaces" / f"{case_id}-git-repos"
        parent.mkdir(parents=True, exist_ok=True)
        repo_paths: dict[str, str] = {}
        for key in REPOS:
            repo, manifest = _create_native_repo(parent, key)
            repo_paths[key] = repo.as_posix()
            manifests[key] = manifest
        root = parent.as_posix()
    else:
        raise FixtureSkip(f"parity008_git_repos unsupported mode: {mode}")

    values: dict[str, str] = getattr(ctx, "values")
    values["parity008_root"] = root
    values["parity008_repo_a"] = repo_paths["a"]
    values["parity008_repo_b"] = repo_paths["b"]
    for key, spec in REPOS.items():
        values[f"parity008_repo_{key}_basename"] = Path(repo_paths[key]).name
        values[f"parity008_{key}_same_txt_head_sha256"] = _sha256(spec["head"])
        values[f"parity008_{key}_same_txt_worktree_sha256"] = _sha256(spec["worktree"])
        if mode == "native":
            values[f"parity008_{key}_index_file_sha256"] = manifests[key]["indexFileSha256"]
            values[f"parity008_{key}_head_ref_sha256"] = manifests[key]["headRefSha256"]

    case_dir = Path(getattr(ctx, "case_dir", report_root))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "parity008-fixture.json").write_text(
        json.dumps({
            "case": case_id,
            "mode": mode,
            "root": root,
            "repos": manifests or {
                key: {
                    "repo": repo_paths[key],
                    "head": REPOS[key]["head"],
                    "worktree": REPOS[key]["worktree"],
                    "headSha256": _sha256(REPOS[key]["head"]),
                    "worktreeSha256": _sha256(REPOS[key]["worktree"]),
                }
                for key in REPOS
            },
        }, indent=2) + "\n",
        encoding="utf-8",
    )


def teardown(_ctx: Any) -> None:
    return None
