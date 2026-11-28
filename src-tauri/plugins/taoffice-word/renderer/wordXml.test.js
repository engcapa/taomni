import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDocx, saveDocxCopy } from "./docxPackage.js";
import { editableParagraphs, patchParagraphs } from "./wordXml.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = new Uint8Array(readFileSync(resolve(here, "../../../../qa-ui-auto-tests/fixtures/taoffice/planning-notes.docx")));

describe("TaOffice Word document copies", () => {
  it("patches the selected paragraph and preserves all other OPC parts", () => {
    const opened = openDocx(source);
    const paragraph = opened.paragraphs.find((entry) => entry.text === "Baseline plan & owners");
    expect(paragraph).toBeDefined();
    const copy = saveDocxCopy(opened, new Map([[paragraph.id, "  Pilot <ready> & 文 📄  "]]));
    const parts = unzipSync(copy);
    expect(Object.keys(parts)).toEqual(Object.keys(opened.parts));
    for (const name of Object.keys(parts)) {
      if (name !== "word/document.xml") expect(parts[name]).toEqual(opened.parts[name]);
    }
    expect(openDocx(copy).paragraphs.map(({ text }) => text)).toContain("  Pilot <ready> & 文 📄  ");
    expect(openDocx(source).paragraphs.map(({ text }) => text)).toContain("Baseline plan & owners");
  });

  it("preserves formatting and the byte ranges of untouched runs and paragraphs", () => {
    const simple = "<w:p><w:r><w:t>Same</w:t></w:r></w:p>";
    const bold = "<w:r><w:rPr><w:b/></w:rPr><w:t>style</w:t></w:r>";
    const mixed = '<w:p><w:r><w:t xml:space="preserve">Mixed </w:t></w:r>' + bold + "</w:p>";
    const table = "<w:tbl><w:tr><w:tc>" + simple + "</w:tc></w:tr></w:tbl>";
    const xml = wrap(mixed + simple + table + simple);
    const paragraphs = editableParagraphs(xml);
    expect(paragraphs.map(({ text, tableDepth }) => [text, tableDepth])).toEqual([
      ["Mixed style", 0], ["Same", 0], ["Same", 1], ["Same", 0],
    ]);
    const copy = patchParagraphs(xml, paragraphs, new Map([[0, "Updated style"], [2, "Cell <ready>"]]));
    expect(copy).toBe(wrap(mixed.replace("Mixed", "Updated") + simple + table.replace("Same", "Cell &lt;ready&gt;") + simple));
  });

  it("supports blank text runs, preserves significant spaces, and leaves complex paragraphs untouched", () => {
    const field = "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:t>Read only</w:t></w:r></w:p>";
    const revision = "<w:p><w:ins><w:r><w:t>Review</w:t></w:r></w:ins></w:p>";
    const blank = "<w:p><w:r><w:t/></w:r></w:p>";
    const mixed = "<w:p><w:r><w:t>😀 Alpha</w:t></w:r><w:r><w:t xml:space='default'>omega 📄</w:t></w:r></w:p>";
    const xml = wrap(revision + field + blank + mixed);
    const paragraphs = editableParagraphs(xml);
    expect(paragraphs.map(({ text }) => text)).toEqual(["", "😀 Alphaomega 📄"]);
    const copy = patchParagraphs(xml, paragraphs, new Map([[0, " Copy "], [1, "📄 Beta omega 😀 "]]));
    expect(copy).toContain(field);
    expect(copy).toContain(revision);
    expect(copy).toContain('<w:t xml:space="preserve"> Copy </w:t>');
    expect(copy).toContain('xml:space="preserve"> omega 😀 ');
    expect(editableParagraphs(copy).map(({ text }) => text)).toEqual([" Copy ", "📄 Beta omega 😀 "]);
  });

  it("rejects a package without a Word main document", () => {
    expect(() => openDocx(new TextEncoder().encode("Unreadable DOCX"))).toThrow();
  });
});

function wrap(body) {
  return '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body + "</w:body></w:document>";
}
