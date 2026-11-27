"""Two deterministic pages with different sizes and visible text."""


def document() -> bytes:
    contents = [b"BT /F1 22 Tf 32 180 Td (Quarterly report) Tj ET",
                b"BT /F1 22 Tf 32 180 Td (Revenue by region) Tj 0 -36 Td (Report notes) Tj ET"]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 460 300] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        *[b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream) for stream in contents],
        b"<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>",
        b"<< /Title (Revenue appendix) /Parent 8 0 R /Dest [4 0 R /Fit] >>",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(b"%d 0 obj\n%s\nendobj\n" % (index, obj))
    xref = len(data)
    data.extend(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        data.extend(b"%010d 00000 n \n" % offset)
    data.extend(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
                % (len(objects) + 1, xref))
    return bytes(data)
