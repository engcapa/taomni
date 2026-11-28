// @vitest-environment node
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { convertOpenDocument } from "./legacyOffice.js";

const fixture = (extension) => new URL(
  `../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-notes.${extension}`,
  import.meta.url,
);
const text = (bytes) => new TextDecoder().decode(bytes);

describe("legacy Word document conversion", () => {
  it.each(["odt", "rtf"])("carries formatted runs, paragraphs and tables from %s into DOCX", async (format) => {
    const input = new Uint8Array(await readFile(fixture(format)));
    const output = unzipSync(await convertOpenDocument(input, format));
    const xml = text(output["word/document.xml"]);
    expect(xml).toContain("Baseline plan &amp; owners");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain(">Ready</w:t>");
    expect(xml).toMatch(/<w:b(?:\s[^>]*)?\/>[^]*?>required\.<\/w:t>/u);
    expect(xml).toContain("Keep the next page unchanged.");
    expect(input).toEqual(new Uint8Array(await readFile(fixture(format))));
  });

  it("retains RTF Unicode and ANSI text in the generated document", async () => {
    const input = new TextEncoder().encode(
      String.raw`{\rtf1\ansi\ansicpg1252\uc1 Caf\'e9 \u20013?\u25991?\par Next paragraph.}`,
    );
    const output = unzipSync(await convertOpenDocument(input, "rtf"));
    const xml = text(output["word/document.xml"]);
    expect(xml).toContain("Café 中文");
    expect(xml).toMatch(/中文[^]*?<\/w:p>[^]*?<w:p[\s>][^]*?Next paragraph\./u);
  });

  it.each(["odt", "rtf"])("rejects unrelated bytes as %s", async (format) => {
    const input = new TextEncoder().encode("This is plain text.");
    await expect(convertOpenDocument(input, format)).rejects.toThrow();
  });
});
