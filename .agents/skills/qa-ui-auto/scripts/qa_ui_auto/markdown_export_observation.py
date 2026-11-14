"""Independent native Markdown clipboard-asset/export artifact verification."""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

from .deadline import budget_time as time
from .steps import StepError

KINDS = {"source", "pasted-image", "html", "png", "docx", "markdown", "absent"}


def validate(args):
    if not isinstance(args, dict) or set(args) - {"kind", "path", "source", "timeout_sec"} or args.get("kind") not in KINDS:
        raise StepError("assert_markdown_artifact: expected kind, path and source")
    if not isinstance(args.get("path"), str) or not isinstance(args.get("source"), str):
        raise StepError("assert_markdown_artifact: exact retained paths required")
    return args


def scoped(ctx, raw):
    requested = Path(raw)
    path = requested.resolve()
    root = ctx.case_dir.parent.resolve()
    if not path.is_relative_to(root) or requested.is_symlink():
        raise StepError("assert_markdown_artifact: path outside run or symlink")
    return path


def png_info(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        rgba = image.convert("RGBA")
        return {"width": image.width, "height": image.height, "pixelSha256": hashlib.sha256(rgba.tobytes()).hexdigest()}


def check_artifact(kind, path, source, manifest):
    text = source.read_text(encoding="utf-8")
    if "# File open Markdown" not in text:
        raise StepError("Source heading changed unexpectedly")
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    if kind == "source":
        expected = manifest.get("savedSourceSha256") or manifest["sourceSha256"]
        if source_sha != expected:
            raise StepError("Source bytes changed during export/cancel/failure")
        return {"sourceSha256": source_sha}
    if kind == "absent":
        if path.exists():
            raise StepError("Cancelled export unexpectedly published an artifact")
        return {"absent": True, "sourceSha256": source_sha}
    if kind == "pasted-image":
        links = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text)
        pasted = [link for link in links if link.startswith("assets/image-")]
        if len(pasted) != 1:
            raise StepError("Expected exactly one standard relative pasted image link")
        from urllib.parse import unquote
        asset = (source.parent / unquote(pasted[0])).resolve()
        if not asset.is_relative_to(source.parent) or not asset.is_file():
            raise StepError("Pasted asset missing/outside source directory")
        original = png_info(Path(manifest["clipboardPng"]).read_bytes())
        actual = png_info(asset.read_bytes())
        if actual != original:
            raise StepError("Pasted native PNG pixels differ from OS clipboard fixture")
        manifest["savedSourceSha256"] = source_sha
        manifest["pastedPath"] = str(asset)
        return {"pasted": str(asset), "pixels": actual, "sourceSha256": source_sha}
    data = b"" if kind == "markdown" else path.read_bytes()
    result = {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "sourceSha256": source_sha}
    if kind == "html":
        html = data.decode("utf-8")
        if "File open Markdown" not in html or "Rendered bold" not in html:
            raise StepError("HTML export lost fixture content")
        if manifest.get("diagramLabels") and (not re.search(r"<svg[\s>]", html) or any(label not in html for label in manifest["diagramLabels"]) or "language-mermaid" in html):
            raise StepError("HTML export lost the actual rendered Mermaid SVG/labels")
        if "\\(" in html or "\\[" in html or "katex" not in html:
            raise StepError("HTML export lost KaTeX-rendered math")
        images = re.findall(r'data:image/png;base64,([A-Za-z0-9+/=]+)', html)
        pixels = [png_info(base64.b64decode(encoded)) for encoded in images]
        expected = png_info(Path(manifest["clipboardPng"]).read_bytes())
        if len(images) < 2 or expected not in pixels:
            raise StepError("HTML is not self-contained or lost pasted image pixels")
        if re.search(r'<img[^>]+src=["\'](?!data:)', html, re.I):
            raise StepError("HTML export contains unresolved image paths")
        result["embeddedImages"] = pixels
    elif kind == "png":
        pixels = png_info(data)
        if pixels["width"] < 400 or pixels["height"] < 200:
            raise StepError("PNG long-image export dimensions too small")
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            rgb = image.convert("RGB")
            if len(rgb.getcolors(maxcolors=8) or []) == 1:
                raise StepError("PNG export is a blank solid image")
            from collections import Counter
            pixels_bytes = rgb.tobytes()
            counts = Counter(zip(pixels_bytes[0::3], pixels_bytes[1::3], pixels_bytes[2::3]))
            with Image.open(manifest["clipboardPng"]) as expected:
                expected_bytes = expected.convert("RGB").tobytes()
                colors = Counter(zip(expected_bytes[0::3], expected_bytes[1::3], expected_bytes[2::3]))
            if len(colors) > 1 and any(counts[color] < min(16, amount) for color, amount in colors.items()):
                raise StepError("PNG export lost known pasted-image color tiles")
            if manifest.get("diagramLabels"):
                diagram_colors = [(219,234,254),(220,252,231),(254,243,199)]
                if any(counts[color] < 50 for color in diagram_colors):
                    raise StepError("PNG export lost the three actual Mermaid node color regions")
        result["pixels"] = pixels
    elif kind == "docx":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if archive.testzip() is not None:
                raise StepError("DOCX ZIP checksum failure")
            xml = archive.read("word/document.xml")
            root = ET.fromstring(xml)
            strings = "".join(root.itertext())
            if "File open Markdown" not in strings or "Rendered bold" not in strings:
                raise StepError("DOCX lost heading/body content")
            media = [name for name in archive.namelist() if name.startswith("word/media/") and name.endswith(".png")]
            expected = png_info(Path(manifest["clipboardPng"]).read_bytes())
            images = [png_info(archive.read(name)) for name in media]
            if len(images) < 2 or expected not in images:
                raise StepError("DOCX did not embed original and pasted image pixels")
            if manifest.get("diagramLabels") and (len(images) < 3 or not any(image["width"] >= 200 and image["height"] >= 30 for image in images)):
                raise StepError("DOCX did not embed rendered Mermaid diagram media")
            result["media"] = media
    elif kind == "markdown":
        # Product creates a collision-safe child named after the source stem.
        directory = path
        exported = directory / source.name
        contents = exported.read_text(encoding="utf-8")
        from urllib.parse import unquote
        images = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", contents)
        if len(images) < 2 or "# File open Markdown" not in contents:
            raise StepError("Markdown folder export content/images missing")
        if manifest.get("diagramLabels") and ("```mermaid" not in contents or any(label not in contents for label in manifest["diagramLabels"])):
            raise StepError("Markdown folder export lost portable Mermaid source")
        pixels = []
        for link in images:
            asset = (directory / unquote(link)).resolve()
            if not asset.is_relative_to(directory) or not asset.is_file():
                raise StepError("Bundled Markdown image does not resolve inside export")
            pixels.append(png_info(asset.read_bytes()))
        expected = png_info(Path(manifest["clipboardPng"]).read_bytes())
        if expected not in pixels:
            raise StepError("Markdown folder export lost pasted image pixels")
        result.update(path=str(directory), images=images)
    return result


def run(ctx, args):
    args = validate(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no host export artifact read"
    source = scoped(ctx, args["source"])
    path = scoped(ctx, args["path"])
    manifest_path = ctx.case_dir / "markdown-native-fixture.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if str(source) != manifest["source"]:
        raise StepError("assert_markdown_artifact: source does not match fixture")
    started = time.monotonic()
    record = {"kind": args["kind"], "mode": "native", "passed": False}
    try:
        while True:
            try:
                result = check_artifact(args["kind"], path, source, manifest)
                break
            except (OSError, StepError, zipfile.BadZipFile) as error:
                if time.monotonic() - started >= float(args.get("timeout_sec", 15)):
                    raise StepError(str(error)) from error
                time.sleep(.1)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        record.update(result, passed=True)
        return "Independent native Markdown artifact matched: " + args["kind"]
    except Exception as error:
        record["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "markdown-artifacts.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
