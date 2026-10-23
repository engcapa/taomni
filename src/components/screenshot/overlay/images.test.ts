import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cropDataUrl, loadArtifact, loadImage } from "./images";

const api = vi.hoisted(() => ({ loadScreenshotUrl: vi.fn(), revokeScreenshotUrl: vi.fn() }));
vi.mock("../../../lib/screenshot", () => api);

interface PendingImage {
  image: HTMLImageElement;
  decoded: () => void;
  failed: (error: Error) => void;
}
const pendingImages: PendingImage[] = [];

beforeEach(() => {
  pendingImages.length = 0;
  vi.clearAllMocks();
  api.loadScreenshotUrl.mockResolvedValue("blob:screenshot");
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    let decoded!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { decoded = resolve; failed = reject; });
    void ready.catch(() => undefined);
    image.decode = vi.fn(() => ready);
    pendingImages.push({ image, decoded, failed });
    return image;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("screenshot image decoding", () => {
  it("publishes a loaded image only after its pixels are decoded for canvas use", async () => {
    const loading = loadImage("capture.png");
    const { image, decoded } = pendingImages[0];
    let published = false;
    void loading.then(() => { published = true; });
    image.onload?.(new Event("load"));
    await Promise.resolve();
    expect(published).toBe(false);
    expect(image.decode).toHaveBeenCalledOnce();
    decoded();
    expect(await loading).toBe(image);
  });

  it("waits for the intermediate PNG to decode before drawing the physical crop", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const exportImage = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,cropped");
    const cropping = cropDataUrl("data:image/png;base64,source", { x: 126, y: 126, width: 508, height: 428 });
    const { image, decoded } = pendingImages[0];
    image.onload?.(new Event("load"));
    await Promise.resolve();
    expect(drawImage).not.toHaveBeenCalled();
    decoded();
    expect(await cropping).toBe("data:image/png;base64,cropped");
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(image, 126, 126, 508, 428, 0, 0, 508, 428);
    expect(exportImage).toHaveBeenCalledExactlyOnceWith("image/png");
  });

  it("releases the owned artifact URL and surfaces a decode failure", async () => {
    const loading = loadArtifact("capture.png");
    const rejected = expect(loading).rejects.toThrow("decode failed");
    await Promise.resolve();
    const { image, failed } = pendingImages[0];
    image.onload?.(new Event("load"));
    failed(new Error("decode failed"));
    await rejected;
    expect(api.revokeScreenshotUrl).toHaveBeenCalledExactlyOnceWith("blob:screenshot");
  });
});
