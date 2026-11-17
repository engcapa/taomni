# PDF search font

`GlyphLessFont.ttf` is the 572-byte glyphless font from Tesseract OCR, licensed under Apache-2.0 (see `LICENSE.txt`).
Source: https://github.com/tesseract-ocr/tesseract/blob/main/tessdata/pdf.ttf
Git blob: `d1472b20ef1aebbf5e11573867e9ac13873681b9`.

The PDF exporter uses this embedded font only for invisible searchable text, with a document-specific Unicode map. Visible text and diagrams retain their rendered appearance. No OCR, font service, installed font or printer is required for the search layer.
