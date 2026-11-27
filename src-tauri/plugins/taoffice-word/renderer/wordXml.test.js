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

  it("selects one of two equal paragraphs and leaves complex runs and body tables intact", () => {
    const wrap = (body) => '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + body + "</w:body></w:document>";
    const simple = "<w:p><w:r><w:t>Same</w:t></w:r></w:p>";
    const mixed = "<w:p><w:r><w:t>Mixed</w:t></w:r><w:r><w:t>style</w:t></w:r></w:p>";
    const table = "<w:tbl><w:tr><w:tc>" + simple + "</w:tc></w:tr></w:tbl>";
    const xml = wrap(mixed + simple + table + simple);
    const paragraphs = editableParagraphs(xml);
    expect(paragraphs.map(({ text }) => text)).toEqual(["Same", "Same"]);
    expect(patchParagraphs(xml, paragraphs, new Map([[1, "Changed"]])))
      .toBe(wrap(mixed + simple + table + simple.replace("Same", "Changed")));
  });

  it("rejects a package without a Word main document", () => {
    expect(() => openDocx(new TextEncoder().encode("Unreadable DOCX"))).toThrow();
  });
});
