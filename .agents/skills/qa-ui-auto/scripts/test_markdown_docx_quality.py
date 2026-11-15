import io
import unittest
import zipfile

from PIL import Image

from qa_ui_auto.markdown_docx_quality import inspect_diagrams
from qa_ui_auto.steps import StepError


def document(pixel_width=1800, pixel_height=900, drawing_width=5486400, drawing_height=2743200, svg=False, vector_target="media/diagram.svg"):
    png = io.BytesIO()
    Image.new("RGB", (pixel_width, pixel_height), "white").save(png, format="PNG")
    output = io.BytesIO()
    xml = f'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="{drawing_width}" cy="{drawing_height}"/>
      <wp:docPr title="Diagram"/><a:graphic><a:blip r:embed="diagram">{('<a:extLst><svgBlip xmlns="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/></a:extLst>' if svg else '')}</a:blip></a:graphic></wp:inline></w:drawing></w:r></w:p>
      <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="720" w:right="720"/></w:sectPr>
      </w:body></w:document>'''
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("word/document.xml", xml)
        archive.writestr("word/_rels/document.xml.rels", f'<Relationships><Relationship Id="diagram" Target="media/diagram.png"/>{(f"<Relationship Id=\"vector\" Target=\"{vector_target}\"/>" if svg else "")}</Relationships>')
        archive.writestr("word/media/diagram.png", png.getvalue())
        if svg:
            archive.writestr("word/media/diagram.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="1" y="20">Diagram</text></svg>')
    output.seek(0)
    return zipfile.ZipFile(output)


class DocxDiagramQualityTest(unittest.TestCase):
    def test_reports_actual_density_and_drawing_size(self):
        with document() as archive:
            result = inspect_diagrams(archive)
        self.assertEqual(result[0]["dpiX"], 300)
        self.assertEqual(result[0]["pixelWidth"], 1800)

    def test_rejects_original_one_pixel_per_css_pixel_path(self):
        with document(pixel_width=576, pixel_height=288) as archive:
            with self.assertRaisesRegex(StepError, "sampling too low"):
                inspect_diagrams(archive)

    def test_rejects_stretched_diagram(self):
        with document(drawing_height=1828800) as archive:
            with self.assertRaisesRegex(StepError, "aspect ratios"):
                inspect_diagrams(archive)

    def test_resolves_vector_extension_and_still_checks_raster_fallback(self):
        with document(svg=True) as archive:
            result = inspect_diagrams(archive)
        self.assertEqual(result[0]["vectorMedia"], ["word/media/diagram.svg"])
        with document(svg=True, pixel_width=576, pixel_height=288) as archive:
            with self.assertRaisesRegex(StepError, "sampling too low"):
                inspect_diagrams(archive)

    def test_rejects_vector_extension_escaping_media_directory(self):
        with document(svg=True, vector_target="../external.svg") as archive:
            with self.assertRaisesRegex(StepError, "invalid media"):
                inspect_diagrams(archive)

    def test_rejects_overflow_even_with_large_media(self):
        with document(pixel_width=3000, pixel_height=1500, drawing_width=9144000, drawing_height=4572000) as archive:
            with self.assertRaisesRegex(StepError, "content width"):
                inspect_diagrams(archive)


if __name__ == "__main__":
    unittest.main()
