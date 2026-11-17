import { afterEach, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";
import { unzlibSync } from "fflate";
import { compressedPdfRgb, registerPdfRgb } from "./pdfRgb";

function canvas(width: number, height: number, rgba: number[]): HTMLCanvasElement {
  return { width, height, getContext: () => ({ getImageData: () => ({ data: Uint8ClampedArray.from(rgba) }) }) } as unknown as HTMLCanvasElement;
}
afterEach(() => vi.unstubAllGlobals());

it("retains exact RGB samples with an offline fallback when CompressionStream is unavailable", async () => {
  vi.stubGlobal("CompressionStream", undefined);
  const packed = await compressedPdfRgb(canvas(2, 1, [255, 0, 0, 255, 0, 63, 255, 255]));
  expect(new DataView(packed.buffer, packed.byteOffset, 8).getUint32(0)).toBe(2);
  expect(new DataView(packed.buffer, packed.byteOffset, 8).getUint32(4)).toBe(1);
  expect(Array.from(unzlibSync(packed.subarray(8)))).toEqual([255, 0, 0, 0, 63, 255]);
});

it("embeds independent image dimensions and compressed streams in simultaneous PDFs", async () => {
  vi.stubGlobal("CompressionStream", undefined);
  registerPdfRgb(jsPDF);
  const first = new jsPDF(), second = new jsPDF();
  const [red, blue] = await Promise.all([
    compressedPdfRgb(canvas(1, 1, [255, 0, 0, 255])),
    compressedPdfRgb(canvas(2, 1, [0, 0, 255, 255, 0, 0, 255, 255])),
  ]);
  first.addImage(red, "TAOMNIRGB", 0, 0, 20, 20, "page-0");
  second.addImage(blue, "TAOMNIRGB", 0, 0, 40, 20, "page-0");
  const a = first.output(), b = second.output();
  expect(a).toContain("/Width 1\n/Height 1");
  expect(b).toContain("/Width 2\n/Height 1");
  for (const output of [a, b]) {
    expect(output).toContain("/ColorSpace /DeviceRGB");
    expect(output).toContain("/BitsPerComponent 8");
    expect(output).toContain("/Filter /FlateDecode");
  }
  const image = (output: string) => {
    const body = output.slice(output.indexOf("/Subtype /Image"));
    const stream = body.slice(body.indexOf("stream\n") + 7, body.indexOf("\nendstream"));
    return Array.from(unzlibSync(Uint8Array.from(stream, (char) => char.charCodeAt(0))));
  };
  expect(image(a)).toEqual([255, 0, 0]); expect(image(b)).toEqual([0, 0, 255, 0, 0, 255]);
});

it("reports a missing canvas context instead of publishing a false PDF", async () => {
  await expect(compressedPdfRgb({ getContext: () => null } as unknown as HTMLCanvasElement)).rejects.toThrow("rendering is unavailable");
});
