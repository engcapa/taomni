"""Deterministic public HOME workload, confined to the fixture's owned child."""
from collections import Counter
from pathlib import Path

from .workspace_json_documents import LONG_JSON_DOCUMENT

WIDE_DOCUMENT_COUNT = 320
PROJECT_GROUPS = 8
PROJECTS_PER_GROUP = 8
FILES_PER_PROJECT = 32
NESTED_LEVELS = 5
PUBLIC_FILES = {
    ".txt": "Public ordinary document\n",
    ".md": "# Public notes\n\nNo private contents.\n",
    ".json": '{"public":true,"items":[1,2,3]}\n',
    ".html": "<!doctype html><html><body>Public page</body></html>\n",
    ".csv": "item,amount\nPublic,42\n",
    ".xml": "<public><value>42</value></public>\n",
    ".yaml": "public: true\nvalue: 42\n",
    ".ini": "[public]\nvalue=42\n",
    ".log": "2026-10-29 INFO public fixture ready\n",
    ".py": "def public_value():\n    return 42\n",
    ".ts": "export const publicValue = 42;\n",
    ".rs": "pub fn public_value() -> u32 { 42 }\n",
    ".java": "class PublicValue { int value = 42; }\n",
    ".go": "package public\nconst Value = 42\n",
    ".sh": "#!/bin/sh\nprintf 'Public fixture\\n'\n",
    ".css": "body { color: teal; }\n",
    ".svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
    ".data": "Public unclassified data\n",
}


def populate(root: Path) -> dict:
    def write(relative: str, contents: str) -> None:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents.encode("utf-8"))

    types = list(PUBLIC_FILES)
    for index in range(WIDE_DOCUMENT_COUNT):
        suffix = types[index % len(types)]
        write(f"Documents/public-{index:04}{suffix}", PUBLIC_FILES[suffix])
    for group in range(PROJECT_GROUPS):
        for project in range(PROJECTS_PER_GROUP):
            base = f"Projects/group-{group:02}/project-{project:02}"
            write(f"{base}/package.json", '{"name":"public-home-fixture","private":true}\n')
            write(f"{base}/.gitignore", "node_modules/\ntarget/\n")
            for index in range(FILES_PER_PROJECT):
                suffix = types[index % len(types)]
                write(f"{base}/src/module-{index // 8:02}/public-{index:03}{suffix}", PUBLIC_FILES[suffix])
    for month in range(12):
        for index in range(24):
            suffix = types[index % len(types)]
            write(f"Archive/2025/month-{month + 1:02}/public-{index:03}{suffix}", PUBLIC_FILES[suffix])
    for index in range(96):
        suffix = types[index % len(types)]
        write(f"Downloads/public-{index:03}{suffix}", PUBLIC_FILES[suffix])
    for index in range(32):
        write(f".cache/public-fixture/entry-{index:03}.json", PUBLIC_FILES[".json"])

    # A sibling at every level prevents path compression from hiding the
    # intermediate tree expansions exercised by the HOME case.
    nested = "Nested"
    levels = []
    for level in range(1, NESTED_LEVELS + 1):
        write(f"{nested}/public-note.txt", PUBLIC_FILES[".txt"])
        nested += f"/Level{level}"
        levels.append(nested)
    write(f"{nested}/deep-long-records.json", LONG_JSON_DOCUMENT)
    write(f"{nested}/page.html", PUBLIC_FILES[".html"])
    (root / "Downloads/public-binary.bin").write_bytes(bytes(range(256)) * 16)

    paths = list(root.rglob("*"))
    files = [path for path in paths if path.is_file()]
    return {
        "schema": "qa-ui-auto.home-layout.v1",
        "fileCount": len(files),
        "directoryCount": sum(path.is_dir() for path in paths),
        "maxDepth": max(len(path.relative_to(root).parts) for path in files),
        "wideDocumentCount": WIDE_DOCUMENT_COUNT,
        "projectCount": PROJECT_GROUPS * PROJECTS_PER_GROUP,
        "types": dict(sorted(Counter(path.suffix or "<none>" for path in files).items())),
        "nestedLevels": levels,
        "deepDocument": f"{nested}/deep-long-records.json",
    }
