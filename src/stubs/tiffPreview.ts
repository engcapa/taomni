import { decode, decodeImage, toRGBA8 } from "utif2";
import { VIEWER_IMAGE_LIMIT } from "../lib/viewer";

export async function renderTiffPreview(buffer: ArrayBuffer) {
  if (buffer.byteLength > VIEWER_IMAGE_LIMIT) throw new Error("too_large: TIFF exceeds the image limit");
  const [page] = decode(buffer);
  const width = page?.t256?.[0];
  const height = page?.t257?.[0];
  if (!width || !height || width * height > 32 * 1024 * 1024) throw new Error("image: Invalid or oversized TIFF");
  decodeImage(buffer, page);
  const pixels = toRGBA8(page);
  if (pixels.length !== width * height * 4) throw new Error("image: Invalid TIFF raster");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("image: TIFF preview requires a canvas");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("image: Cannot render TIFF"));
  }, "image/png"));
  if (png.size > VIEWER_IMAGE_LIMIT) throw new Error("too_large: TIFF preview exceeds the image limit");
  return { mime: "image/png", bytes: Array.from(new Uint8Array(await png.arrayBuffer())), size: png.size };
}
