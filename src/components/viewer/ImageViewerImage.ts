export { safeImageBlob } from "../../lib/imageSafety";

export const IMAGE_VIEWER_LIMIT = 32 * 1024 * 1024;
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

export function imageExtension(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

export function fitImageScale(width: number, height: number, viewportWidth: number, viewportHeight: number, rotation = 0): number {
  if (!width || !height || !viewportWidth || !viewportHeight) return 1;
  const sideways = Math.abs(rotation % 180) === 90;
  return Math.min(1, Math.max(1, viewportWidth - 48) / (sideways ? height : width), Math.max(1, viewportHeight - 48) / (sideways ? width : height));
}

export function clampImageScale(scale: number): number {
  return Math.max(0.01, Math.min(32, scale));
}

/** Export the displayed orientation, at intrinsic resolution rather than the current UI zoom. */
export function imageToPng(image: HTMLImageElement, rotation: number, flipped: boolean): Promise<Blob> {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return Promise.reject(new Error("Image is not ready"));
  // Bound canvas allocation independently of compressed file size (decompression bombs).
  if (width * height > 32 * 1024 * 1024) return Promise.reject(new Error("PNG export is limited to 32 megapixels"));
  const canvas = document.createElement("canvas");
  const sideways = Math.abs(rotation % 180) === 90;
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Image export is unavailable"));
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.scale(flipped ? -1 : 1, 1);
  context.drawImage(image, -width / 2, -height / 2);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png"));
}
