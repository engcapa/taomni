"""Small nested workspace shared by Project tree reference and native checks."""
from pathlib import Path
import tempfile

SEED_FILES = {
    "README.md": "# project-tree-e2e\n\nDisposable project tree reference and verification fixture.\n\nKeep this content when browsing, collapsing, selecting and reopening files.\n",
    "src/main/example.txt": "Project tree example\nThe editor buffer should survive tree navigation.\n",
    "docs/notes.txt": "Reference notes\nSecond file for selection and editor tab checks.\n",
    "tests/sample.txt": "Example test data\n",
}


def setup(ctx):
    from . import FixtureSkip
    if ctx.cfg.get("app", {}).get("mode") != "native":
        raise FixtureSkip("project_tree needs native filesystem reads; browser VFS is separate")
    base = Path(ctx.report_root).resolve() / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="project-tree-", dir=base))
    for relative, text in SEED_FILES.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
    ctx.values["project_tree_root"] = root.as_posix()
    # Retained under report_root for both failure inspection and normal rotation.
