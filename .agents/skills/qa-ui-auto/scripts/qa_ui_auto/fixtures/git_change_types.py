"""Staged Modified and Added files plus a matching commit in an isolated repo."""
import json
import subprocess
from pathlib import Path
from typing import Any

from . import parity008_git


def setup(ctx: Any) -> None:
    parity008_git.setup(ctx)
    repo = f'{ctx.values["parity008_root"]}/repo-b'
    if (ctx.cfg.get("app") or {}).get("mode", "browser") == "browser":
        ctx.page.wait_for_load_state("domcontentloaded")
        ctx.page.evaluate("""async (repo) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsWriteText(repo + '/added.txt', 'added baseline\\n');
          await vfs.vfsWriteText(repo + '/new.txt', 'added worktree\\n');
          localStorage.setItem('taomni.qa.parity008.changeTypes', 'true');
        }""", repo)
        manifest = {"repo": repo, "provider": "controlled browser", "statuses": ["modified", "added"]}
    else:
        path = Path(repo)
        def git(*args: str) -> str:
            return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True,
                                  text=True, encoding="utf-8", timeout=20).stdout.strip()
        (path / "added.txt").write_text("added baseline\n", encoding="utf-8")
        git("add", "same.txt", "added.txt")
        git("commit", "--no-gpg-sign", "-m", "change types baseline")
        (path / "same.txt").write_text("modified staged worktree\n", encoding="utf-8")
        (path / "new.txt").write_text("added worktree\n", encoding="utf-8")
        git("add", "same.txt", "new.txt")
        manifest = {"repo": repo, "provider": "native git", "status": git("status", "--porcelain"),
                    "staged": git("diff", "--cached", "--name-status"),
                    "commitFiles": git("diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"),
                    "history": git("log", "-2", "--format=%H %s")}
    (Path(ctx.case_dir) / "git-change-types-fixture.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


teardown = parity008_git.teardown
