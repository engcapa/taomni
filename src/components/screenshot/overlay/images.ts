import { loadScreenshotUrl, revokeScreenshotUrl } from "../../../lib/screenshot";
import { paintWatermark, type WatermarkSettings } from "../../../lib/screenshotImage";

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  // decode() settles once the bitmap is loaded and decoded, without waiting
  // for a load event first. WebKit can fire load before the bitmap is ready
  // for drawImage, so publish only decoded pixels: an immediate export can
  // never become transparent. A broken or missing image rejects here too.
  await image.decode();
  return image;
}

/** Load a backend artifact into an image backed by a same-origin URL. */
export async function loadArtifact(path: string, onRead?: () => void): Promise<{ img: HTMLImageElement; url: string; }> {
  const url = await loadScreenshotUrl(path);
  onRead?.();
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
