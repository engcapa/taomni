"""Restore artifact directories; never rewrite signed runner evidence."""
from pathlib import Path
import shutil
import sys

source, target = map(Path, sys.argv[1:])
target.mkdir(parents=True, exist_ok=True)
for artifact in source.iterdir():
    if artifact.name.startswith('qa-selection-'):
        shutil.copy2(artifact / 'selection.json', target / 'selection.json')
    elif artifact.name.startswith('qa-'):
        entry = artifact.name.removeprefix('qa-').rsplit('-', 1)[0]
        shutil.copytree(artifact, target / entry, dirs_exist_ok=True)
if not (target / 'selection.json').is_file():
    raise SystemExit('Selection artifact missing: planning failed; no execution claimed')
