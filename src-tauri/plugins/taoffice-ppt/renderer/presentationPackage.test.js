import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPresentation } from "./createPresentation.js";
import { openPresentation, presentationPreviewBytes, savePresentationCopy } from "./presentationPackage.js";

const bytes = new Uint8Array(readFileSync(resolve("qa-ui-auto-tests/fixtures/taoffice/ppt-review.pptx")));
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function xml(data) { return decoder.decode(data); }

describe("PPTX presentation packages", () => {
  it("preserves presentation order from OPC relationships", () => {
    const parts = unzipSync(bytes);
    const name = "ppt/presentation.xml";
    const entries = xml(parts[name]).match(/<p:sldId\s[^>]*\/>/gu);
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    parts[name] = encoder.encode(xml(parts[name]).replace(first + second, second + first));
    const opened = openPresentation(zipSync(parts));
    expect(opened.slides.map((slide) => slide.visible[0])).toEqual(["Delivery appendix", "Quarterly review"]);
  });

  it("patches mixed-style runs and table-cell text without changing other package parts", () => {
    const opened = openPresentation(bytes);
    const changes = new Map();
    for (const paragraph of opened.slides[0].paragraphs) {
      if (paragraph.text === "Pilot moves with approval") changes.set(paragraph.id, "Pilot moves after legal & customer approval");
      if (paragraph.text === "Ready") changes.set(paragraph.id, " Ready <for launch> ");
    }
    expect(changes.size).toBe(2);
    const updated = savePresentationCopy(opened, changes);
    const reread = openPresentation(updated);
    expect(reread.slides[0].paragraphs.map((paragraph) => paragraph.text))
      .toEqual(expect.arrayContaining(["Pilot moves after legal & customer approval", " Ready <for launch> "]));
    const originalSlide = opened.slides[0].xml;
    const patchedSlide = reread.slides[0].xml;
    const runProperties = (slide) => slide.match(/<a:rPr[^>]*(?:\/>|>.*?<\/a:rPr>)/gus);
    expect(runProperties(patchedSlide)).toEqual(runProperties(originalSlide));
    expect(patchedSlide).toContain('xml:space="preserve"> Ready &lt;for launch&gt; ');
    expect(Object.keys(reread.parts).sort()).toEqual(Object.keys(opened.parts).sort());
    for (const [name, content] of Object.entries(opened.parts)) {
      if (name !== opened.slides[0].path) expect(Buffer.from(reread.parts[name]).equals(Buffer.from(content)), name).toBe(true);
    }
    expect(savePresentationCopy(opened, new Map())).toBe(bytes);
  });

  it("filters external and root-escaping preview relationships without removing them from the saved copy", () => {
    const original = unzipSync(bytes);
    const name = "ppt/slides/_rels/slide1.xml.rels";
    original[name] = encoder.encode(xml(original[name]).replace("</Relationships>", [
      '<Relationship Id="rIdExternal" Type="image" TargetMode="External" Target="https://example.invalid/ppt.png"/>',
      '<Relationship Id="rIdAbsolute" Type="image" Target="https://example.invalid/undocumented.png"/>',
      '<Relationship Id="rIdEscape" Type="image" Target="../../../other.png"/>',
      "</Relationships>",
    ].join("")));
    const opened = openPresentation(zipSync(original));
    const edited = new Map([[opened.slides[0].paragraphs[0].id, "Edited"]]);
    const preview = unzipSync(presentationPreviewBytes(opened, edited));
    expect(xml(preview[name])).not.toMatch(/rIdExternal|rIdAbsolute|rIdEscape/u);
    expect(xml(preview[name])).toContain("slideLayout1.xml");
    expect(xml(unzipSync(savePresentationCopy(opened, edited))[name])).toBe(xml(original[name]));
  });

  it("keeps signed presentations read-only and rejects invalid replacement text", () => {
    const original = unzipSync(bytes);
    original["_xmlsignatures/sig1.xml"] = encoder.encode("<Signature/>");
    const signed = openPresentation(zipSync(original));
    const paragraph = signed.slides[0].paragraphs[0];
    expect(signed.editable).toBe(false);
    expect(() => savePresentationCopy(signed, new Map([[paragraph.id, "Edited"]]))).toThrow("read-only");
    expect(() => savePresentationCopy(openPresentation(bytes), new Map([[paragraph.id, "invalid\nreplacement"]]))).toThrow("single line");
  });

  it("rejects path traversal and XML document types before providing preview bytes", () => {
    const parts = unzipSync(bytes);
    parts["../escaped.xml"] = encoder.encode("<test/>");
    expect(() => openPresentation(zipSync(parts))).toThrow();
    delete parts["../escaped.xml"];
    const slide = "ppt/slides/slide1.xml";
    parts[slide] = encoder.encode(xml(parts[slide]).replace("?>", '?><!DOCTYPE p:sld SYSTEM "https://example.invalid/ppt.dtd">'));
    expect(() => openPresentation(zipSync(parts))).toThrow("document type");
  });

  it("creates a standard 16:9 presentation with editable title and subtitle", async () => {
    const opened = openPresentation(await createPresentation("Launch update", "March readiness"));
    expect(opened.width / opened.height).toBeCloseTo(16 / 9);
    expect(opened.slides).toHaveLength(1);
    expect(opened.slides[0].paragraphs.map((paragraph) => paragraph.text)).toEqual(["Launch update", "March readiness"]);
  });
});
