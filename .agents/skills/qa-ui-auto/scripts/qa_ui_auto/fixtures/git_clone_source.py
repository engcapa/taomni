"""Isolated Git source repository for workspace clone import cases.

Browser mode seeds the deterministic clone stub and returns a VFS destination.
Native mode creates a real repository outside the checkout and a fresh clone
parent under the system temp directory, so the packaged app exercises real Git,
the filesystem and repository-local configuration without using the network.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

BROWSER_ROOT = "/preview/workspaces"
BROWSER_DESTINATION = f"{BROWSER_ROOT}/qa-clone"
BROWSER_URL = "https://github.com/engcapa/qa-clone.git"


def _git(repo: Path, *args: str) -> str:
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


def _write(repo: Path, relative: str, contents: str) -> None:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8", newline="\n")


def _enclosing_repo(path: Path) -> Path | None:
    return next((parent for parent in [path, *path.parents] if (parent / ".git").exists()), None)


def create_native_fixture(parent: Path) -> dict[str, str]:
    parent.mkdir(parents=True, exist_ok=True)
    if _enclosing_repo(parent.resolve()) is not None:
        raise RuntimeError(f"git_clone_source: fixture parent {parent} is inside a Git repository")
    workspace = Path(tempfile.mkdtemp(prefix="git-clone-", dir=str(parent))).resolve()
    source = workspace / "source-repo"
    source.mkdir()
    _git(source, "init", "-b", "main")
    _git(source, "config", "user.name", "Git Clone Fixture")
    _git(source, "config", "user.email", "git-clone-fixture@example.invalid")
    _git(source, "config", "core.autocrlf", "false")
    _git(source, "config", "commit.gpgsign", "false")
    _write(source, "README.md", "# qa clone source\n\nmain branch\n")
    _write(source, "src/main.ts", "export const branch = 'main';\n")
    _git(source, "add", "-A")
    _git(source, "commit", "--no-gpg-sign", "-m", "fixture main")
    _git(source, "checkout", "-b", "develop")
    _write(source, "branch-only.txt", "develop-only\n")
    _git(source, "add", "-A")
    _git(source, "commit", "--no-gpg-sign", "-m", "fixture develop")
    _git(source, "checkout", "main")
    parent_dir = workspace / "clones"
    parent_dir.mkdir()
    workspace_name = "qa-clone-workspace"
    destination = parent_dir / workspace_name
    return {
        "url": source.as_posix(),
        "source": source.as_posix(),
        "parent": parent_dir.as_posix(),
        "destination": destination.as_posix(),
        "workspace_name": workspace_name,
        "branch": "develop",
        "main_file": "README.md",
        "branch_file": "branch-only.txt",
        "head": _git(source, "rev-parse", "develop"),
    }


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    values: dict[str, str] = getattr(ctx, "values")
    if mode == "browser":
        page = getattr(ctx, "page", None)
        if page is None:
            raise RuntimeError("git_clone_source needs a browser page")
        page.goto(cfg["app"]["base_url"], wait_until="commit")
        page.evaluate(
            """({parent, url}) => {
              localStorage.setItem('taomni.qa.gitClone', JSON.stringify({
                defaults: {
                  userName: 'QA Stub User',
                  userEmail: 'qa-clone@example.invalid',
                  defaultBranch: 'main',
                  cloneRoot: parent,
                  appProxyEnabled: true,
                  appProxyUrl: 'http://192.168.0.110:31028',
                  appProxyError: null,
                  vaultState: 'unlocked',
                  savedTokenAvailable: true
                },
                probe: {defaultBranch: 'trunk', branches: ['trunk', 'release']},
                scenario: 'slow',
                seedFiles: {'src/cloned.ts': "export const cloned = 'qa-ui-auto';\\n"}
              }));
              localStorage.removeItem('taomni.qa.gitClone.lastRequest');
            }""",
            {"parent": BROWSER_ROOT, "url": BROWSER_URL},
        )
        manifest = {
            "provider": "browser git clone stub",
            "url": BROWSER_URL,
            "parent": BROWSER_ROOT,
            "destination": BROWSER_DESTINATION,
            "defaultBranch": "trunk",
        }
        values["git_clone_url"] = BROWSER_URL
        values["git_clone_parent"] = BROWSER_ROOT
        values["git_clone_destination"] = BROWSER_DESTINATION
        values["git_clone_workspace_name"] = "qa-clone"
        values["git_clone_branch"] = "trunk"
        values["git_clone_main_file"] = "README.md"
        values["git_clone_branch_file"] = "branch-only.txt"
    elif mode == "native":
        parent_root = Path(tempfile.gettempdir()) / "taomni-qa-git-clone"
        manifest_values = create_native_fixture(parent_root)
        values.update({f"git_clone_{key}": value for key, value in manifest_values.items()})
        values["git_clone_url"] = manifest_values["url"]
        values["git_clone_parent"] = manifest_values["parent"]
        values["git_clone_destination"] = manifest_values["destination"]
        values["git_clone_workspace_name"] = manifest_values["workspace_name"]
        values["git_clone_branch"] = manifest_values["branch"]
        values["git_clone_main_file"] = manifest_values["main_file"]
        values["git_clone_branch_file"] = manifest_values["branch_file"]
        manifest = manifest_values
    else:
        raise FixtureSkip(f"git_clone_source unsupported mode: {mode}")
    case_dir = Path(getattr(ctx, "case_dir", getattr(ctx, "report_root", Path("qa-ui-auto-report"))))
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "git-clone-source-fixture.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )


def teardown(_ctx: Any) -> None:
    # Keep the repository and clone output with the report for byte audit.
    return None
