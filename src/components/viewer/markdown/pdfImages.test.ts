import { afterEach, describe, expect, it, vi } from "vitest";
import { paintPdfImages, preparePdfImages } from "./pdfImages";

const box = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
function image(root: HTMLElement, rect: DOMRect) {
  const img = document.createElement("img");
  Object.defineProperties(img, { naturalWidth: { value: 1600 }, naturalHeight: { value: 800 } });
  img.style.borderRadius = "8px";
  img.style.borderTopLeftRadius = "8px";
  img.getBoundingClientRect = () => rect;
  root.append(img);
  return img;
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("PDF raster resources", () => {
  it("paints original decoded images on the translated page inside the content clip", () => {
    const root = document.createElement("div"); document.body.append(root);
    root.style.opacity = "0.8";
    const original = image(root, box(120, 260, 600, 300));
    image(root, box(120, -500, 600, 300));
    const images = preparePdfImages(root);
    expect(original.style.visibility).toBe("hidden");
    const page = document.createElement("div"), viewport = document.createElement("div");
    page.getBoundingClientRect = () => box(100, 200, 800, 1100);
    viewport.getBoundingClientRect = () => box(120, 220, 600, 700);
    const canvas = document.createElement("canvas"); canvas.width = 2500; canvas.height = 3437;
    const context = { save: vi.fn(), restore: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), drawImage: vi.fn(), globalAlpha: 1 };
    vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    paintPdfImages(images, canvas, page, viewport);
    expect(context.scale).toHaveBeenCalledWith(2500 / 800, 3437 / 1100);
    expect(context.rect).toHaveBeenCalledWith(20, 20, 600, 700);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(original, 20, 60, 600, 300);
    expect(context.roundRect).toHaveBeenCalledWith(20, 60, 600, 300, 8);
    expect(context.globalAlpha).toBe(0.8);
    expect(context.save).toHaveBeenCalledTimes(2);
    expect(context.restore).toHaveBeenCalledTimes(2);
  });

  it("retains contain geometry when an image is constrained by both page dimensions", () => {
    const root = document.createElement("div"); document.body.append(root);
    const img = image(root, box(0, 0, 600, 600));
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 600;
    const area = document.createElement("div"); area.getBoundingClientRect = () => box(0, 0, 600, 600);
    const context = { save: vi.fn(), restore: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), drawImage: vi.fn(), globalAlpha: 1 };
    vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    paintPdfImages(preparePdfImages(root), canvas, area, area);
    expect(context.drawImage).toHaveBeenCalledWith(img, 0, 150, 600, 300);
  });

  it("keeps deliberately hidden images hidden and rejects unavailable image pixels", () => {
    const root = document.createElement("div"); document.body.append(root);
    image(root, box(0, 0, 100, 50)).style.visibility = "hidden";
    expect(preparePdfImages(root)).toHaveLength(0);
    root.append(document.createElement("img"));
    expect(() => preparePdfImages(root)).toThrow("Cannot decode");
  });
});
