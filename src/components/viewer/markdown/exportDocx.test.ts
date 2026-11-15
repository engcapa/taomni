import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownDocx } from "./exportDocx";
import { DEFAULT_EXPORT_SETTINGS } from "./exportModel";
// @ts-expect-error Node-only ZIP inspection stays in the unit test.
import { inflateRawSync } from "node:zlib";

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (blob.arrayBuffer) return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.onerror = reject; reader.readAsArrayBuffer(blob);
  });
}

function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true), local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const dataOffset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataOffset, dataOffset + size);
    entries.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : data);
  }
  return entries;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it("embeds actual SVG with a 300dpi PNG fallback and page-based Word display extents", async () => {
    const samples: Array<[number, number]> = [];
    vi.stubGlobal("Image", class {
      naturalWidth = 300; naturalHeight = 150;
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      samples.push([this.width, this.height]); return `data:image/png;base64,${png}`;
    });
    const root = document.createElement("div");
    root.innerHTML = '<div class="fv-md-mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 1000 500"><rect width="1000" height="500" fill="#fff"/><text x="50" y="80">清晰 Diagram</text></svg></div>';
    const blob = await markdownDocx(root, "diagram.md", DEFAULT_EXPORT_SETTINGS);
    const entries = zipEntries(await blobBytes(blob));
    const svg = [...entries].find(([name]) => name.startsWith("word/media/") && name.endsWith(".svg"));
    expect(svg).toBeDefined();
    expect(new TextDecoder().decode(svg![1])).toContain("清晰 Diagram");
    expect([...entries.keys()].some((name) => name.startsWith("word/media/") && name.endsWith(".png"))).toBe(true);
    const xml = new TextDecoder().decode(entries.get("word/document.xml"));
    expect(xml).toContain("svgBlip");
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
    expect(extent).not.toBeNull();
    const inches = Number(extent[1]) / 914400;
    expect(inches).toBeGreaterThan(6);
    expect(samples[0][0] / inches).toBeGreaterThanOrEqual(300);
    expect(samples[0][0] / samples[0][1]).toBeCloseTo(2, 2);
    expect(xml).toContain('title="Diagram"');
  });
});
