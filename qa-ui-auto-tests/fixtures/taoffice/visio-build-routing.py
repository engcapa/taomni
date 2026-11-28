"""Generate a two-page OPC Visio drawing for the TaOffice QA cases."""

from pathlib import Path
from xml.sax.saxutils import escape
import zipfile


VISIO = "http://schemas.microsoft.com/office/visio/2012/main"
OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
VISIO_REL = "http://schemas.microsoft.com/visio/2010/relationships"


def relationships(*items):
    entries = "".join(
        f'<Relationship Id="rId{index}" Type="{VISIO_REL}/{kind}" Target="{path}"/>'
        for index, (kind, path) in enumerate(items, 1)
    )
    return f'<Relationships xmlns="{PACKAGE}">{entries}</Relationships>'


def cell(name, value):
    return f'<Cell N="{name}" V="{value}"/>'


def shape(number, x, y, width, height, text, fill, points):
    geometry = "".join(
        f'<Row T="{kind}" IX="{index}">{cell("X", px)}{cell("Y", py)}</Row>'
        for index, (kind, px, py) in enumerate(points, 1)
    )
    transform = "".join(cell(name, value) for name, value in {
        "PinX": x, "PinY": y, "Width": width, "Height": height,
        "LocPinX": width / 2, "LocPinY": height / 2,
    }.items())
    text_style = f'<Section N="Character"><Row IX="0">{cell("Size", 0.18)}</Row></Section>'
    line = cell("LineColor", "#1e3a5f") + cell("LinePattern", 1) + cell("LineWeight", 0.02)
    fill_settings = (cell("FillForegnd", fill) if fill else "") + cell("FillPattern", 1 if fill else 0)
    text_element = f"<Text>{escape(text)}</Text>" if text else ""
    return (
        f'<Shape ID="{number}" Type="Shape">{transform}{line}{fill_settings}{text_style}'
        f'<Section N="Geometry" IX="0">{cell("NoFill", 0 if fill else 1)}{geometry}</Section>'
        f"{text_element}</Shape>"
    )


def page(label, status, color):
    rectangle = [("MoveTo", 0, 0), ("LineTo", 2, 0), ("LineTo", 2, 0.8),
                 ("LineTo", 0, 0.8), ("LineTo", 0, 0)]
    connector = [("MoveTo", 0, 0), ("LineTo", 2, 0)]
    return (
        f'<PageContents xmlns="{VISIO}"><Shapes>'
        f'{shape(1, 2, 2, 2, 0.8, label, color, rectangle)}'
        f'{shape(2, 4, 2, 2, 0, "", "", connector)}'
        f'{shape(3, 6, 2, 2, 0.8, status, "#f2efd7", rectangle)}'
        "</Shapes></PageContents>"
    )


def build(path):
    titles = ["Routing overview", "Delivery details"]
    page_parts = [f"page{index}.xml" for index in range(1, len(titles) + 1)]
    pages = "".join(
        f'<Page ID="{index}" Name="{name}" NameU="{name}"><PageSheet>'
        f'{cell("PageWidth", 8)}{cell("PageHeight", 4)}</PageSheet><Rel r:id="rId{index}"/></Page>'
        for index, name in enumerate(titles, 1)
    )
    overrides = "".join(
        f'<Override PartName="/{part}" ContentType="application/vnd.ms-visio.{kind}+xml"/>'
        for kind, part in [
            ("drawing.main", "visio/document.xml"), ("pages", "visio/pages/pages.xml"),
            *(("page", "visio/pages/" + name) for name in page_parts),
        ]
    )
    parts = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            f'<Default Extension="xml" ContentType="application/xml"/>{overrides}</Types>'
        ),
        "_rels/.rels": relationships(("document", "visio/document.xml")),
        "visio/document.xml": f'<VisioDocument xmlns="{VISIO}"/>',
        "visio/_rels/document.xml.rels": relationships(("pages", "pages/pages.xml")),
        "visio/pages/pages.xml": f'<Pages xmlns="{VISIO}" xmlns:r="{OFFICE}">{pages}</Pages>',
        "visio/pages/_rels/pages.xml.rels": relationships(*(("page", name) for name in page_parts)),
        "visio/pages/page1.xml": page("Routing intake", "Queue", "#dae8fb"),
        "visio/pages/page2.xml": page("Routing approval", "Delivery", "#dfeddb"),
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in parts.items():
            archive.writestr(zipfile.ZipInfo(name), content.encode(), compress_type=zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    build(Path(__file__).with_name("visio-routing.vsdx"))
