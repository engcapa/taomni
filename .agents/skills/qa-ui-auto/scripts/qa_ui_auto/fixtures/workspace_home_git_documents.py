"""Real Git repositories, entirely inside the owned public HOME fixture."""
import subprocess
from pathlib import Path
from typing import Any

from . import workspace_home_documents


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, timeout=20)


def setup(ctx: Any) -> None:
    workspace_home_documents.setup(ctx)
    owned = Path(ctx.values["workspace_home_fixture_root"])
    documents = owned / "Documents"
    git(documents, "init", "--initial-branch=qa-home")
    git(documents, "add", "notes.txt")
    git(documents, "-c", "user.name=QA Fixture", "-c", "user.email=qa@example.invalid",
        "commit", "-m", "Public initial note")
    changed = "Public tracked note modified in HOME\n"
    (documents / "notes.txt").write_bytes(changed.encode("utf-8"))
    ctx.values["workspace_notes_text"] = changed
    unrelated = owned / "Unrelated"
    unrelated.mkdir()
    git(unrelated, "init", "--initial-branch=qa-unrelated")
    (unrelated / "unrelated.txt").write_text("Public unrelated repository\n", encoding="utf-8")
