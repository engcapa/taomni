import { loadScreenshotUrl, revokeScreenshotUrl } from "../../../lib/screenshot";
import { paintWatermark, type WatermarkSettings } from "../../../lib/screenshotImage";

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("failed to load screenshot image"));
    image.src = src;
  });
}

/** Load a backend artifact into an image backed by a same-origin URL. */
export async function loadArtifact(path: string): Promise<{ img: HTMLImageElement; url: string; }> {
  const url = await loadScreenshotUrl(path);
  try {
    return { img: await loadImage(url), url };
  } catch (e) {
    revokeScreenshotUrl(url);
    throw e;
  }
}

/** Crop a PNG data URL to a device-pixel rect. */
export function cropDataUrl(dataUrl: string, r: { x: number; y: number; width: number; height: number; }): Promise<string> {
  return loadImage(dataUrl).then((image) => {
    const c = document.createElement("canvas");
    c.width = r.width;
    c.height = r.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return c.toDataURL("image/png");
  });
}

/** Apply the same seeded, scattered watermark layout to every export. */
export function applyWatermark(dataUrl: string, wm: WatermarkSettings): Promise<string> {
  return loadImage(dataUrl).then((image) => {
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(image, 0, 0);
    paintWatermark(ctx, c.width, c.height, wm);
    return c.toDataURL("image/png");
  });
}
