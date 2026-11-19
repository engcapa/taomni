"""Markdown files with known PNG pixels and three loopback routes."""
import io
import json
from pathlib import Path
from uuid import uuid4

from PIL import Image

from . import html_network_test, markdown_drawio_roundtrip, platform_workspace_root
from .mobile_connection_auth import app_proxy_fixture_path


def setup(ctx):
    platform_workspace_root.setup(ctx)
    root = ctx.values["platform_workspace_root"]
    native = ctx.cfg["app"]["mode"] == "native"
    pixels = io.BytesIO()
    Image.new("RGB", (96, 64), (42, 116, 190)).save(pixels, format="PNG")
    image_route = "/markdown-images/remote.png"
    servers = html_network_test.Servers(ctx.case_dir, uuid4().hex, {image_route: pixels.getvalue()})
    ctx.markdown_image_servers = servers
    ctx.markdown_proxy_backup = None
    try:
        reference = servers.origin + image_route
        drawing = (markdown_drawio_roundtrip.ASSETS / "swimlanes.drawio").read_text(encoding="utf-8")
        files = {
            root + "/remote-images.md": f"# Remote image\n\n![Remote fixture]({reference})\n",
            root + "/image-interactions.md": (
                f"# Image interactions\n\nCopy this rendered sentence.\n\n![Remote fixture]({reference})\n\n"
                "```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```\n\n"
                f"```drawio\n{drawing}\n```\n"
            ),
        }
        if native:
            for path, content in files.items():
                Path(path).write_text(content, encoding="utf-8")
            proxy_path = app_proxy_fixture_path(ctx)
            ctx.markdown_proxy_backup = (proxy_path, proxy_path.read_bytes() if proxy_path.exists() else None)
            proxy_path.parent.mkdir(parents=True, exist_ok=True)
            proxy_path.write_text(json.dumps(html_network_test.proxy(servers.servers[1].server_port)), encoding="utf-8")
        else:
            ctx.page.evaluate(
                """async (files) => {
                    const {vfsWriteText} = await import('/src/stubs/localVfs.ts');
                    for (const [path, content] of Object.entries(files)) await vfsWriteText(path, content);
                }""", files
            )
        ctx.values.update(
            markdown_image_log=str(servers.log.resolve()),
            markdown_image_custom_port=str(servers.servers[2].server_port),
            markdown_remote_html=str((ctx.case_dir / "remote-images.html").resolve()),
            markdown_remote_png=str((ctx.case_dir / "rotated-markdown.png").resolve()),
        )
    except BaseException:
        teardown(ctx)
        raise


def teardown(ctx):
    servers = getattr(ctx, "markdown_image_servers", None)
    if servers:
        ctx.markdown_image_servers = None
        servers.close()
    backup = getattr(ctx, "markdown_proxy_backup", None)
    if backup:
        ctx.markdown_proxy_backup = None
        path, previous = backup
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(previous)
