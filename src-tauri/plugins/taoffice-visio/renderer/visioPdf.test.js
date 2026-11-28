// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { PDFDocument, PDFName, decodePDFRawStream } from "@cantoo/pdf-lib";
import { exportVisioPdf } from "./visioPdf.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO4y8DAoPkQAAZoAeg3PFolAAAAAElFTkSuQmCC", "base64");
const diagram = { width: 240, height: 120, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>' };

function canvasFixture() {
  const paint = { fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    getContext: vi.fn(() => paint),
    toBlob: vi.fn(callback => callback(new Blob([png], { type: "image/png" }))),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  vi.stubGlobal("Image", class { async decode() {} });
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:page");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { canvas, paint, createUrl, revokeUrl };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exports the current sanitized SVG on white paper at its original point size with lossless colors", async () => {
  const { canvas, paint, createUrl, revokeUrl } = canvasFixture();
  const pdf = await PDFDocument.load(await exportVisioPdf(diagram));
  expect(pdf.getPageCount()).toBe(1);
  const page = pdf.getPages()[0];
  expect(page.getSize()).toEqual({ width: 180, height: 90 });
  const objects = page.node.Resources().lookup(PDFName.of("XObject"));
  const bitmap = objects.lookup(objects.keys()[0]);
  expect(bitmap.dict.lookup(PDFName.of("ColorSpace")).toString()).toBe("/DeviceRGB");
  expect([...decodePDFRawStream(bitmap).decode()]).toEqual([221, 0, 0, 0, 41, 225]);
  expect(await createUrl.mock.calls[0][0].text()).toBe(diagram.svg);
  expect(paint.fillStyle).toBe("white");
  expect(paint.fillRect).toHaveBeenCalledWith(0, 0, 480, 240);
  expect(paint.drawImage).toHaveBeenCalledWith(expect.objectContaining({ src: "blob:page" }), 0, 0, 480, 240);
  expect(revokeUrl).toHaveBeenCalledWith("blob:page");
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
});

it.each([[4097, 1], [2049, 2048], [0, 1], [1, Infinity], [-1, 1]])(
  "rejects unsupported page dimensions %s × %s before allocating a bitmap", async (width, height) => {
    const { createUrl } = canvasFixture();
    await expect(exportVisioPdf({ ...diagram, width, height })).rejects.toThrow("pdf-limits");
    expect(createUrl).not.toHaveBeenCalled();
  },
);

it("reduces print resolution on a large page and preserves its full page size", async () => {
  const { paint } = canvasFixture();
  const pdf = await PDFDocument.load(await exportVisioPdf({ ...diagram, width: 2048, height: 2048 }));
  expect(paint.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 2048);
  expect(pdf.getPage(0).getSize()).toEqual({ width: 1536, height: 1536 });
});

it("releases a failed encoding and allows the same drawing to be exported on retry", async () => {
  const { canvas, revokeUrl } = canvasFixture();
  canvas.toBlob.mockImplementationOnce(callback => callback(null));
  await expect(exportVisioPdf(diagram)).rejects.toThrow("pdf-render");
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  expect(canvas.width).toBe(0);
  expect((await PDFDocument.load(await exportVisioPdf(diagram))).getPageCount()).toBe(1);
  expect(revokeUrl).toHaveBeenCalledTimes(2);
});
