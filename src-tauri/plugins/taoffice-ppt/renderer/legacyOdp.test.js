// @vitest-environment node
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { finalizeConvertedPresentation } from "./convertedPresentation.js";
import { convertOdp } from "./legacyOdp.js";
import { slideParagraphs } from "./slideText.js";

const fixtures = new URL("../../../../qa-ui-auto-tests/fixtures/taoffice/", import.meta.url);

describe("OpenDocument presentation import", () => {
  it("preserves page order, editable text, table values and chart data in slide XML", async () => {
    const input = await readFile(new URL("legacy-review.odp", fixtures));
    const converted = await convertOdp(input);
    const parts = unzipSync(finalizeConvertedPresentation(converted, "odp"));
    expect(strFromU8(parts["ppt/viewProps.xml"])).not.toContain("<p:normalViewPr/>");
    const slide = (index) => slideParagraphs(new TextDecoder().decode(parts["ppt/slides/slide" + index + ".xml"]));
    expect(slide(1).paragraphs.map((item) => item.text)).toEqual([
      "Quarterly review", "Pilot moves with approval", "Workstream", "Status", "Release", "Ready",
    ]);
    expect(slide(2).visible).toEqual(expect.arrayContaining(["Delivery appendix", "Unchanged second slide", "Completed"]));
    expect(parts["ppt/slides/slide3.xml"]).toBeUndefined();
  });

  it("rejects damaged bytes and unrelated files instead of creating a replacement slide", async () => {
    await expect(convertOdp(new Uint8Array(40))).rejects.toThrow();
    await expect(convertOdp(await readFile(new URL("legacy-notes.odt", fixtures)))).rejects.toThrow();
  });
});

describe("PowerPoint notes master compatibility", () => {
  it("gives the generated notes master its own identical theme without changing the slide master", () => {
    const theme = "ppt/theme/theme1.xml";
    const notes = "ppt/notesMasters/_rels/notesMaster1.xml.rels";
    const slide = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
    const relationship = strToU8('<Relationships><Relationship Target="../theme/theme1.xml"/></Relationships>');
    const source = zipSync({
      [theme]: strToU8("<theme/>"),
      [notes]: relationship,
      [slide]: relationship,
      "[Content_Types].xml": strToU8("<Types></Types>"),
    });
    const converted = finalizeConvertedPresentation(source, "ppt");
    const result = unzipSync(converted);
    expect(result["ppt/theme/theme2.xml"]).toEqual(result[theme]);
    expect(result[slide]).toEqual(relationship);
    expect(strFromU8(result[notes])).toContain('Target="../theme/theme2.xml"');
    expect(strFromU8(result["[Content_Types].xml"])).toContain('PartName="/ppt/theme/theme2.xml"');
    expect(finalizeConvertedPresentation(converted, "ppt")).toBe(converted);
  });
});
