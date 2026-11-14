import { describe, expect, it, vi } from "vitest";
import { clampImageScale, fitImageScale, imageToPng, safeImageBlob } from "./ImageViewerImage";

const bytes = (text: string) => new TextEncoder().encode(text);
const textOf = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = reject;
  reader.readAsText(blob);
});

describe("shared offline image policy", () => {
  it("uses explicit caller size budgets without weakening Explorer's 20 MiB cap", () => {
    expect(safeImageBlob([1, 2, 3], "image/png; x=1", 3).type).toBe("image/png");
    expect(() => safeImageBlob([1, 2, 3], "image/png", 2)).toThrow("too_large");
    expect(() => safeImageBlob([1], "text/html", 10)).toThrow("Unsupported image format");
    expect(() => safeImageBlob([1], "image/png", 20 * 1024 * 1024)).not.toThrow();
  });

  it("removes active and external SVG content while retaining local gradients", async () => {
    const original = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:base="https://tracker.invalid/" viewBox="0 0 20 20" onload="alert(1)"><script>alert(1)</script><style>path{fill:red}</style><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/><path fill="url(https://tracker.invalid/pixel)"/><image href="file:///secret"/><use xlink:href="https://tracker.invalid/other.svg"/><foreignObject><div>unsafe</div></foreignObject><animate attributeName="href" to="https://tracker.invalid"/></svg>';
    const clean = await textOf(safeImageBlob(bytes(original), "image/svg+xml", 10240));
    const document = new DOMParser().parseFromString(clean, "image/svg+xml");
    expect(document.querySelector("linearGradient")).not.toBeNull();
    expect(document.querySelector("rect")?.getAttribute("fill")).toBe("url(#g)");
    expect(document.querySelector("script,style,image,use,foreignObject,animate")).toBeNull();
    expect(document.querySelector("[onload],[href],[style]" )).toBeNull();
    expect(clean).not.toMatch(/tracker|file:|xml:base/);
    expect(original).toContain("<script>");
  });

  it("accepts the clean SVG source used by the native edit workflow", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#16a34a"/></svg>\n';
    const clean = await textOf(safeImageBlob(bytes(source), "image/svg+xml", 10240));
    expect(clean).toContain('width="160"');
    expect(clean).toContain('height="90"');
    expect(clean).toContain("#16a34a");
  });

  it.each(["not svg", "<svg><unclosed></svg>", "<html></html>"])("rejects malformed or non-SVG input %s", (source) => {
    expect(() => safeImageBlob(bytes(source), "image/svg+xml", 1024)).toThrow("Invalid SVG image");
  });
});

describe("image transform math and PNG export", () => {
  it("fits without upscaling and accounts for quarter-turn orientation", () => {
    expect(fitImageScale(100, 100, 600, 400)).toBe(1);
    expect(fitImageScale(1200, 800, 648, 448)).toBe(0.5);
    expect(fitImageScale(1200, 800, 648, 448, 90)).toBeCloseTo(1 / 3);
    expect(fitImageScale(0, 0, 0, 0)).toBe(1);
    expect(clampImageScale(100)).toBe(32);
    expect(clampImageScale(0.001)).toBe(0.01);
  });

  it("exports intrinsic pixels with rotation and flip, never viewport zoom", async () => {
    const context = { translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn() };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      expect(this.width).toBe(200);
      expect(this.height).toBe(300);
      callback(new Blob(["png"], { type: "image/png" }));
    });
    const image = { naturalWidth: 300, naturalHeight: 200 } as HTMLImageElement;
    expect((await imageToPng(image, 90, true)).type).toBe("image/png");
    expect(context.translate).toHaveBeenCalledWith(100, 150);
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(context.scale).toHaveBeenCalledWith(-1, 1);
    expect(context.drawImage).toHaveBeenCalledWith(image, -150, -100);
    getContext.mockRestore(); toBlob.mockRestore();
  });

  it("bounds decoded canvas allocation and rejects not-yet-decoded images", async () => {
    await expect(imageToPng({ naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement, 0, false)).rejects.toThrow("not ready");
    await expect(imageToPng({ naturalWidth: 20000, naturalHeight: 20000 } as HTMLImageElement, 0, false)).rejects.toThrow("32 megapixels");
  });
});
