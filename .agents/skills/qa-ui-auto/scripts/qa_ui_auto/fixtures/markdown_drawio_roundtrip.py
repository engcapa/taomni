"""Real diagrams.net source and a Desktop PNG reference for both runners."""
from pathlib import Path
from shutil import copyfile

from . import platform_workspace_root

ASSETS = Path(__file__).resolve().parents[6] / "qa-ui-auto-tests/fixtures/markdown-drawio"


def setup(ctx):
    platform_workspace_root.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    source = "# Drawing round trip\n\nKeep this Markdown outside the diagram.\n"
    paths = {
        root + "/drawio-roundtrip.md": source,
        root + "/drawio-actions.md": "# Diagram actions\n\n```drawio\n" + (ASSETS / "swimlanes.drawio").read_text(encoding="utf-8") + "```\n",
    }
    if ctx.cfg["app"]["mode"] == "native":
        for path, content in paths.items():
            Path(path).write_text(content, encoding="utf-8")
    else:
        ctx.page.evaluate(
            """async (paths) => {
                const vfs = await import('/src/stubs/localVfs.ts');
                for (const [path, source] of Object.entries(paths)) await vfs.vfsWriteText(path, source);
            }""",
            paths,
        )
    case_dir = ctx.case_dir.resolve()
    for name in ("roundtrip.drawio", "roundtrip.drawio.png", "legacy-assets.drawio"):
        copyfile(ASSETS / name, case_dir / name)
    ctx.values.update(
        drawio_roundtrip_input=str(case_dir / "roundtrip.drawio"),
        drawio_roundtrip_export=str(case_dir / "roundtrip-export.drawio"),
        drawio_roundtrip_markdown=root + "/drawio-roundtrip.md",
        drawio_context_png=str(case_dir / "drawio-context.png"),
        drawio_legacy_input=str(case_dir / "legacy-assets.drawio"),
    )
