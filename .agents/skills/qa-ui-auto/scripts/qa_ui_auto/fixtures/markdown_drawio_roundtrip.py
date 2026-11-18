"""Real diagrams.net source and a Desktop PNG reference for both runners."""
from pathlib import Path
from shutil import copyfile

from . import platform_workspace_root

ASSETS = Path(__file__).resolve().parents[6] / "qa-ui-auto-tests/fixtures/markdown-drawio"


def setup(ctx):
    platform_workspace_root.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    source = "# Drawing round trip\n\nKeep this Markdown outside the diagram.\n"
    path = root + "/drawio-roundtrip.md"
    if ctx.cfg["app"]["mode"] == "native":
        Path(path).write_text(source, encoding="utf-8")
    else:
        ctx.page.evaluate(
            """async ({path, source}) => {
                const vfs = await import('/src/stubs/localVfs.ts');
                await vfs.vfsWriteText(path, source);
            }""",
            {"path": path, "source": source},
        )
    case_dir = ctx.case_dir.resolve()
    for name in ("roundtrip.drawio", "roundtrip.drawio.png"):
        copyfile(ASSETS / name, case_dir / name)
    ctx.values.update(
        drawio_roundtrip_input=str(case_dir / "roundtrip.drawio"),
        drawio_roundtrip_export=str(case_dir / "roundtrip-export.drawio"),
        drawio_roundtrip_markdown=path,
    )
