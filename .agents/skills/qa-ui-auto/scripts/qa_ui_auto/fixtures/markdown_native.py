"""Native-only Markdown OS clipboard, chooser and actual export fixtures."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import file_open_files


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("markdown_native requires native mode")
    file_open_files.setup(ctx)
    from .. import host_clipboard
    try:
        ctx._markdown_clipboard_before = host_clipboard.get_text()
    except Exception:
        ctx._markdown_clipboard_before = None
    root = Path(ctx.values["file_open_root"])
    exports = root / "exports"
    exports.mkdir()
    # Distinct known pixels let the oracle distinguish an existing source image
    # from the clipboard item or a duplicated placeholder after export.
    from PIL import Image
    image = Image.new("RGBA", (24, 16), (21, 105, 201, 255))
    for x in range(12):
        for y in range(8):
            image.putpixel((x, y), (224, 81, 37, 255))
    clipboard = root / "clipboard.png"
    image.save(clipboard)
    source = root / "live.md"
    # Native diagram fixture is independent of browser004's content contract.
    diagram = "\n## Delivery graph\n\n```mermaid\nflowchart LR\n  A[Markdown Source] --> B[Live Diagram]\n  B --> C[Export Artifact]\n  style A fill:#dbeafe,stroke:#2563eb\n  style B fill:#dcfce7,stroke:#16a34a\n  style C fill:#fef3c7,stroke:#d97706\n```\n"
    source.write_bytes(("# File open Markdown\n\n**Rendered bold** and `inline code`.\n\nMath: $x^2$ and $$\\frac{1}{2}$$.\n\n## Details\n\n![Original](assets/pixel.png)\n\n- [ ] First task\n" + diagram).encode("utf-8"))
    bad_source = root / "missing-image.md"
    bad_text = "# Missing image\n\n![Missing](assets/does-not-exist.png)\n"
    bad_source.write_bytes(bad_text.encode())
    manifest = {"source": str(source.resolve()), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "clipboardPng": str(clipboard), "exports": str(exports), "mode": "native",
                "diagramLabels": ["Markdown Source", "Live Diagram", "Export Artifact"]}
    (ctx.case_dir / "markdown-native-fixture.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    ctx.values.update(markdown_native_source=str(source), markdown_native_root=str(root),
                      markdown_native_exports=str(exports), markdown_native_clipboard=str(clipboard),
                      markdown_native_missing_sha=hashlib.sha256(bad_text.encode()).hexdigest())


def teardown(ctx):
    from .. import host_clipboard
    previous = getattr(ctx, "_markdown_clipboard_before", None)
    if previous is None:
        host_clipboard.clear()
    else:
        host_clipboard.set_text(previous)
    # Non-text native clipboard formats cannot be restored without retaining
    # personal data or a long-lived owner. Record that boundary, never hide it.
    (ctx.case_dir / "markdown-clipboard-cleanup.json").write_text(json.dumps({
        "textRestored": previous is not None, "nonTextPreviousFormatsNotRestored": True,
    }), encoding="utf-8")
