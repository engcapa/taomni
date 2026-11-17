"""Independent checks of exports from the exact user-reported testing.md."""
import io
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from .steps import StepError


def inspect_word_strokes(svg):
    edges = [node for node in svg.iter() if "flowchart-link" in node.get("class", "").split()]
    for edge in edges:
        if edge.get("stroke") in (None, "none", "transparent") or float(edge.get("stroke-width", "0").removesuffix("px")) <= 0:
            raise StepError("Word flowchart line has no visible stroke")
        pattern = edge.get("stroke-dasharray", "none")
        if pattern != "none":
            lengths = [float(part.removesuffix("px")) for part in re.split(r"[ ,]+", pattern)]
            if len(lengths) % 2:
                lengths *= 2
            if all(length == 0 for length in lengths[1::2]):
                raise StepError("Word flowchart line still uses an Office-invisible zero-gap dash pattern")
    return len(edges)


def inspect_word_text_layout(svg):
    positioned=0
    cjk=re.compile(r'[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]')
    for text in (node for node in svg.iter() if node.tag.rsplit('}',1)[-1]=='text'):
        if not cjk.search(''.join(text.itertext())):
            continue
        leaves=[node for node in text.iter() if node.tag.rsplit('}',1)[-1]=='tspan' and not list(node) and cjk.search(node.text or '')]
        if not leaves:
            raise StepError('Word CJK label still depends on Office fallback text metrics')
        for span in leaves:
            if len(span.text or '')!=1 or span.get('text-anchor')!='start':
                raise StepError('Word CJK label still depends on Office fallback text metrics')
            try:
                point=[float(span.get(name,'')) for name in ('x','y')]
                if not all(math.isfinite(value) for value in point):raise ValueError()
            except ValueError as error:
                raise StepError('Word CJK glyph has invalid measured coordinates') from error
            positioned+=1
    return positioned


def inspect_testing(path, kind):
    data = Path(path).read_bytes()
    if kind == "testing-pdf":
        from pypdf import PdfReader
        from PIL import ImageStat
        reader = PdfReader(io.BytesIO(data), strict=True)
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        for label in ("AI Agent", "Planning", "Observation", "死循环防护", "幂等性控制"):
            if label not in text:
                raise StepError("Reported Markdown PDF lost searchable text: " + label)
        pages = []
        for page in reader.pages:
            draws = [operands[0] for operands, operator in page.get_contents().operations if operator == b"Do"]
            if len(draws) != 1:
                raise StepError("Reported Markdown PDF lost a complete rendered page")
            image = page.images[draws[0]].image.convert("RGB")
            dpi = min(image.width / (float(page.mediabox.width) / 72), image.height / (float(page.mediabox.height) / 72))
            if dpi < 299 or max(ImageStat.Stat(image).stddev) < 3:
                raise StepError("Reported Markdown PDF page is blank or below 300 DPI")
            pages.append(dict(width=image.width, height=image.height, dpi=dpi))
        return dict(pageCount=len(pages), pages=pages, searchableText=text)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        from .markdown_docx_quality import inspect_diagrams
        drawings = inspect_diagrams(archive, minimum_dpi=590)
        vectors = [name for name in archive.namelist() if name.startswith("word/media/") and name.endswith(".svg")]
        if len(vectors) != 2 or len(drawings) != 2:
            raise StepError("Reported Markdown Word lost either diagram vector/fallback")
        svgs = [ET.fromstring(archive.read(name)) for name in vectors]
        lines = sum(inspect_word_strokes(svg) for svg in svgs)
        positioned_cjk = sum(inspect_word_text_layout(svg) for svg in svgs)
        if lines != 13:
            raise StepError("Reported Markdown Word lost flowchart line bodies")
        labels = ["".join(node.itertext()) for svg in svgs for node in svg.iter() if node.tag.endswith("}text")]
        for expected in ("用户输入", "规划层", "反思与自愈调整", "交付最终结果", "MCP", "评估目标是否达成?", "整理并生成最终答复", "未完成 / 发生错误"):
            if not any(expected in text for text in labels):
                raise StepError("Reported Markdown Word lost label: " + expected)
        document = ET.fromstring(archive.read("word/document.xml"))
        if "幂等性控制" not in "".join(document.itertext()):
            raise StepError("Reported Markdown Word lost the final table")
        return dict(vectorCount=len(vectors), flowchartLineBodies=lines, positionedCjkGlyphs=positioned_cjk, diagrams=drawings, labels=labels)
