import { describe, expect, it } from "vitest";
import { markdownDocx } from "./exportDocx";
import { DEFAULT_EXPORT_SETTINGS } from "./exportModel";

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (blob.arrayBuffer) return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.onerror = reject; reader.readAsArrayBuffer(blob);
  });
}

describe("real lazy Word package", () => {
  it("emits an actual DOCX ZIP with paragraphs, GFM tables, headers and footer", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<h1>Title</h1><p>A <strong>bold</strong> line <a href="https://example.test">link</a>.</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table><ul><li>first</li><li>second</li></ul>';
    const blob = await markdownDocx(root, "a.md", { ...DEFAULT_EXPORT_SETTINGS, fileHeader: true });
    const bytes = await blobBytes(blob);
    expect(bytes.slice(0, 4)).toEqual(Uint8Array.of(0x50, 0x4b, 0x03, 0x04));
    const archive = new TextDecoder().decode(bytes);
    expect(archive).toContain("word/document.xml");
    expect(archive).toContain("word/header1.xml");
    expect(archive).toContain("word/footer1.xml");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
