import { describe, expect, it } from "vitest";
import { editableParagraphs } from "./wordXml.js";
import { wordPageLayout } from "./wordPageLayout.js";

function layout(body) {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body + "</w:body></w:document>";
  return wordPageLayout({ xml, paragraphs: editableParagraphs(xml) });
}

describe("Word editing page", () => {
  it("places repeated text in its own body paragraph or merged cell and preserves read-only fields", () => {
    const plain = "<w:p><w:r><w:t>Later</w:t></w:r></w:p>";
    const { blocks: [title, field, table, last], paper } = layout(
      '<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Review</w:t></w:r></w:p>'
      + '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:t>Field result</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + plain
      + "</w:tc></w:tr></w:tbl>" + plain + '<w:sectPr><w:pgSz w:w="15840" w:h="12240"/>'
      + '<w:pgMar w:left="720" w:right="1440" w:top="0"/></w:sectPr>');
    expect(paper).toMatchObject({ width: "11in", minHeight: "8.5in", paddingLeft: "0.5in", paddingTop: "0in" });
    expect(title).toMatchObject({ heading: true, align: "center", paragraph: { id: 0 } });
    expect(field.text).toBe("Field result");
    expect(field.paragraph).toBeUndefined();
    expect(table.rows[0][0]).toMatchObject({ span: 2, blocks: [{ paragraph: { id: 1, tableDepth: 1 } }] });
    expect(last).toMatchObject({ paragraph: { id: 2, tableDepth: 0 } });
  });
});
