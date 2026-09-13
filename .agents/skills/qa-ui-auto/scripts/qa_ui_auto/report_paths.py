"""Discover nested run summaries without walking profiles or checkout fixtures."""
import os
from pathlib import Path


def summaries(root: Path) -> list[Path]:
    if root.is_file():
        return [root.resolve()]
    excluded = {"node_modules", ".git", "target", "dist", "native-appdata",
                "native-appcache", "native-workspaces", "__pycache__"}
    found = []
    for current, directories, files in os.walk(root, followlinks=False):
        directory = Path(current)
        if directory != root and (".git" in directories or ".git" in files):
            directories[:] = []
            continue
        def linked(path: Path) -> bool:
            junction = getattr(path, "is_junction", None)
            return path.is_symlink() or bool(junction and junction())
        directories[:] = [name for name in directories if name not in excluded
                          and not linked(directory / name)]
        if "summary.json" in files:
            found.append((directory / "summary.json").resolve())
    return sorted(set(found))
