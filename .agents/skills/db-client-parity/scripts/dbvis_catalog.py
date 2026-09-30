#!/usr/bin/env python3
"""Extract DbVisualizer menu/toolbar/popup trees and per-engine object views from an install.

    python .agents/skills/db-client-parity/scripts/dbvis_catalog.py \
      --home C:/software/DbVisualizer --out qa-ui-auto-report/dbvis-reference/_install

Writes menus.md (every top-level action-list resolved to action names) and
object-views.md (object tree node types and view tabs per profile). Install-file
evidence only: it proves entries exist, not behaviour or default key bindings.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile


def menus(home: Path) -> str:
    with zipfile.ZipFile(home / "lib" / "dbvis.jar") as jar:
        source = jar.read("dbvis-actions.xml").decode("utf-8")
    root = ET.fromstring(re.sub(r"<!DOCTYPE[^>]*>", "", source))
    actions = {action.get("id"): action for action in root.iter("action")}

    def label(node: ET.Element) -> str:
        ref = node.get("idref") or node.get("id")
        action = actions.get(ref)
        name = action.get("name") if action is not None and action.get("name") else ref
        return f"{name.replace('&', '')}  [{ref}]"

    lines: list[str] = []

    def walk(parent: ET.Element, depth: int) -> None:
        for child in parent:
            if child.tag == "empty":
                lines.append("  " * depth + "---")
            elif child.tag in {"action", "action-list", "group"}:
                lines.append("  " * depth + "- " + label(child))
                if child.tag != "action":
                    walk(child, depth + 1)

    for top in root:
        if top.tag == "action-list":
            lines.append(f"\n## {top.get('id')}")
            walk(top, 0)
    return "\n".join(lines) + "\n"


def object_views(home: Path) -> str:
    lines = []
    for profile in sorted((home / "resources" / "profiles").glob("*.xml")):
        text = profile.read_text(encoding="utf-8", errors="replace")
        views = re.findall(r'<ObjectView type="([^"]+)">(.*?)</ObjectView>', text, re.S)
        if not views:
            continue
        lines.append(f"\n## {profile.stem}")
        for object_type, body in views:
            tabs = re.findall(r'<DataView[^>]*?label="([^"]+)"', body)
            lines.append(f"- {object_type}: {', '.join(tabs)}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", type=Path, default=Path("C:/software/DbVisualizer"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "menus.md").write_text(menus(args.home), encoding="utf-8")
    (args.out / "object-views.md").write_text(object_views(args.home), encoding="utf-8")
    print(f"wrote {args.out / 'menus.md'} and {args.out / 'object-views.md'}")


if __name__ == "__main__":
    main()
