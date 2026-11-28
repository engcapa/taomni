import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePsd } from "./psd.js";
import { pixelThumbnail } from "./previewRaster.js";

vi.mock("./previewRaster.js", async (importOriginal) => ({
  ...await importOriginal(),
  pixelThumbnail: vi.fn((width, height) => Promise.resolve({ width, height, blob: new Blob() })),
}));

const fixtures = resolve(import.meta.dirname, "../../../../qa-ui-auto-tests/fixtures/taoffice");
const fixture = () => new Uint8Array(readFileSync(resolve(fixtures, "image-sample.psd")));

function previewPixel(x, y) {
  const [, , orientation, getPixel] = pixelThumbnail.mock.lastCall;
  const value = new Uint8ClampedArray(4);
  expect(orientation).toBe(1);
  getPixel(x, y, value, 0);
  return [...value];
}

function composite(data, { width = 2, height = 1, channels = 3, depth = 8, mode = 3, compression = 0 } = {}) {
  const bytes = new Uint8Array(40 + data.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x38, 0x42, 0x50, 0x53, 0, 1]);
  view.setUint16(12, channels);
  view.setUint32(14, height);
  view.setUint32(18, width);
  view.setUint16(22, depth);
  view.setUint16(24, mode);
  view.setUint16(38, compression);
  bytes.set(data, 40);
  return bytes;
}

beforeEach(() => pixelThumbnail.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("Photoshop previews", () => {
  it("reads the PackBits composite across separate color planes", async () => {
    const file = fixture();
    const original = file.slice();
    await expect(decodePsd(file)).resolves.toMatchObject({ width: 96, height: 64 });
    expect(previewPixel(16, 32)).toEqual([216, 92, 36, 255]);
    expect(previewPixel(80, 32)).toEqual([40, 113, 191, 255]);
    expect(file).toEqual(original);
  });

  it("prefers a Photoshop 4 BGR thumbnail resource without reading the composite", async () => {
    const header = composite([], { width: 50, height: 50 }).subarray(0, 30);
    const bytes = new Uint8Array(30 + 4 + 44);
    bytes.set(header);
    const view = new DataView(bytes.buffer);
    view.setUint32(30, 44); // Resource section length
    view.setUint32(34, 0x3842494d); // 8BIM
    view.setUint16(38, 1033);
    view.setUint32(42, 32); // Thumbnail resource length
    view.setUint32(50, 1); // Width
    view.setUint32(54, 1); // Height
    view.setUint32(58, 4); // Padded row length
    view.setUint32(62, 4); // Uncompressed length
    view.setUint32(66, 4); // Stored length
    view.setUint16(70, 24);
    view.setUint16(72, 1);
    bytes.set([36, 92, 216, 0], 74);
    await expect(decodePsd(bytes)).resolves.toMatchObject({ width: 1, height: 1 });
    expect(previewPixel(0, 0)).toEqual([216, 92, 36, 255]);
  });

  it("reads big-endian 16-bit samples and repeats the gray channel", async () => {
    await decodePsd(composite([23, 255, 179, 0], { depth: 16, channels: 1, mode: 1 }));
    expect(previewPixel(0, 0)).toEqual([23, 23, 23, 255]);
    expect(previewPixel(1, 0)).toEqual([179, 179, 179, 255]);
  });

  it("restores the color under documented merged transparency", async () => {
    const bytes = composite([226, 226, 162, 162, 130, 130, 128, 128], { channels: 4 });
    const merged = new Uint8Array(bytes.length + 6);
    merged.set(bytes.subarray(0, 38));
    merged.set(bytes.subarray(38), 44);
    const view = new DataView(merged.buffer);
    view.setUint32(34, 6);
    view.setUint32(38, 2);
    view.setInt16(42, -1);
    await decodePsd(merged);
    expect(previewPixel(1, 0)).toEqual([197, 70, 6, 128]);
  });

  it("handles ZIP prediction separately for each row and color plane", async () => {
    vi.stubGlobal("Blob", (await import("node:buffer")).Blob);
    const input = Uint8Array.of(10, 30, 240, 20, 3, 153);
    await decodePsd(composite(deflateSync(input), { compression: 3 }));
    expect(previewPixel(0, 0)).toEqual([10, 240, 3, 255]);
    expect(previewPixel(1, 0)).toEqual([40, 4, 156, 255]);
  });

  it("rejects truncated PackBits rows and ZIP output that exceeds the expected image", async () => {
    vi.stubGlobal("Blob", (await import("node:buffer")).Blob);
    await expect(decodePsd(fixture().subarray(0, -1))).rejects.toMatchObject({ code: "psd-format" });
    await expect(decodePsd(composite(deflateSync(new Uint8Array(4096)), { compression: 2 })))
      .rejects.toMatchObject({ code: "psd-format" });
    expect(pixelThumbnail).not.toHaveBeenCalled();
  });

  it("states why a large or unsupported composite cannot be displayed", async () => {
    await expect(decodePsd(composite([], { width: 30_000, height: 30_000 })))
      .rejects.toMatchObject({ code: "image-preview-size" });
    await expect(decodePsd(composite([], { mode: 4 }))).rejects.toMatchObject({ code: "psd-no-preview" });
    expect(pixelThumbnail).not.toHaveBeenCalled();
  });
});
