import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeRaw } from "./raw.js";
import { decodeJpeg, pixelThumbnail, validDimensions } from "./previewRaster.js";

vi.mock("./previewRaster.js", async (importOriginal) => ({
  ...await importOriginal(),
  decodeJpeg: vi.fn(async (_bytes, { width, height }) => ({ width, height, blob: new Blob() })),
  pixelThumbnail: vi.fn(async (width, height) => ({ width, height, blob: new Blob() })),
}));

const fixtures = resolve(import.meta.dirname, "../../../../qa-ui-auto-tests/fixtures/taoffice");
const fixture = (name) => new Uint8Array(readFileSync(resolve(fixtures, name)));

function littleEndianDng() {
  const data = fixture("image-sample.dng");
  const view = new DataView(data.buffer);
  const root = view.getUint32(4, true);
  const next = root + 2 + view.getUint16(root, true) * 12;
  const preview = view.getUint32(next, true);
  return { data, view, root, next, preview };
}

function field(view, directory, tag, littleEndian) {
  const count = view.getUint16(directory, littleEndian);
  for (let index = 0; index < count; index++) {
    const offset = directory + 2 + index * 12;
    if (view.getUint16(offset, littleEndian) === tag) return offset + 8;
  }
  throw new Error("Missing tag in the test fixture.");
}

beforeEach(() => {
  decodeJpeg.mockClear();
  pixelThumbnail.mockClear();
});

describe("Camera RAW previews", () => {
  it("opens a TIFF-addressed preview without decoding or altering the sensor pixels", async () => {
    const bytes = fixture("image-sample.dng");
    const original = bytes.slice();
    await expect(decodeRaw(bytes)).resolves.toMatchObject({ width: 96, height: 64 });
    expect(decodeJpeg).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array),
      expect.objectContaining({ width: 96, height: 64 }), 1, undefined);
    expect(pixelThumbnail).not.toHaveBeenCalled();
    expect(bytes).toEqual(original);
  });

  it("uses a preview's orientation and terminates cyclic TIFF traversal", async () => {
    const { data, view, preview } = littleEndianDng();
    view.setUint16(field(view, preview, 274, true), 6, true);
    view.setUint32(preview + 2 + 12 * view.getUint16(preview, true), preview, true);
    await decodeRaw(data);
    expect(decodeJpeg.mock.lastCall[2]).toBe(6);
  });

  it("reports missing previews, incorrect directories and oversized JPEG frames separately", async () => {
    const { data, view, preview } = littleEndianDng();
    const jpeg = view.getUint32(field(view, preview, 513, true), true);
    const frame = data.findIndex((value, offset) => offset > jpeg && value === 0xff && data[offset + 1] === 0xc0);
    view.setUint16(frame + 7, 25_000);
    await expect(decodeRaw(data)).rejects.toMatchObject({ code: "image-preview-size" });
    await expect(decodeRaw(fixture("image-no-preview.dng"))).rejects.toMatchObject({ code: "raw-no-preview" });
    await expect(decodeRaw(data.subarray(0, 13))).rejects.toMatchObject({ code: "raw-format" });
    expect(decodeJpeg).not.toHaveBeenCalled();
    expect(validDimensions(9000, 9000)).toBe(false);
  });

  it("reads packed preview colors from a big-endian multi-strip TIFF image", async () => {
    const tags = [
      [254, 4, 1, 1], [256, 4, 1, 2], [257, 4, 1, 2], [258, 3, 3, 158], [259, 3, 1, 1],
      [262, 3, 1, 2], [273, 4, 2, 164], [274, 3, 1, 8], [277, 3, 1, 3],
      [278, 4, 1, 1], [279, 4, 2, 172], [284, 3, 1, 1],
    ];
    const bytes = new Uint8Array(192);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x4d4d);
    view.setUint16(2, 42);
    view.setUint32(4, 8);
    view.setUint16(8, tags.length);
    for (const [index, [tag, type, count, value]] of tags.entries()) {
      const offset = 10 + index * 12;
      view.setUint16(offset, tag);
      view.setUint16(offset + 2, type);
      view.setUint32(offset + 4, count);
      if (type === 3 && count === 1) view.setUint16(offset + 8, value);
      else view.setUint32(offset + 8, value);
    }
    bytes.set([0, 8, 0, 8, 0, 8], 158);
    view.setUint32(164, 180);
    view.setUint32(168, 186);
    view.setUint32(172, 6);
    view.setUint32(176, 6);
    bytes.set([32, 44, 60, 10, 20, 30, 3, 2, 1, 91, 92, 93], 180);

    await decodeRaw(bytes);
    const [width, height, orientation, pixel] = pixelThumbnail.mock.lastCall;
    expect([width, height, orientation]).toEqual([2, 2, 8]);
    const output = new Uint8ClampedArray(4);
    pixel(1, 1, output, 0);
    expect([...output]).toEqual([91, 92, 93, 255]);
    expect(decodeJpeg).not.toHaveBeenCalled();
  });

  it("honors an aborted document request before decoding", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(decodeRaw(fixture("image-sample.dng"), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(decodeJpeg).not.toHaveBeenCalled();
  });
});
