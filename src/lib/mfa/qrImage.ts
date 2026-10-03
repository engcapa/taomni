// QR decoding for every MFA import source. The decoder (`qr`, paulmillr) is
// pure JS so it runs identically in the Tauri WebView and browser preview,
// and is loaded on demand to stay out of the main bundle.

import type { MfaLumaFrame } from "./types";

type DecodeModule = typeof import("qr/decode.js");

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Longest side handed to the decoder; larger images are scaled down. */
export const MAX_DECODE_SIDE = 3840;
/** Video frames are scaled to this width before decoding (speed over range). */
export const CAMERA_DECODE_WIDTH = 1280;

let decoder: Promise<DecodeModule> | null = null;

export function loadQrDecoder(): Promise<DecodeModule> {
  decoder ??= import("qr/decode.js");
  return decoder;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function decodeAll(images: RgbaImage[], format?: "I420"): Promise<string[]> {
  if (images.length === 0) return [];
  const { decodeQRBatch } = await loadQrDecoder();
  const maxSize = {
    width: Math.max(...images.map((image) => image.width)),
    height: Math.max(...images.map((image) => image.height)),
  };
  const results = await decodeQRBatch(images, {
    ...(format ? { format } : {}),
    maxSize,
    effort: Number.POSITIVE_INFINITY,
    timeLimit: 3000,
  });
  return unique(results.flat().filter((result): result is string => typeof result === "string"));
}

/** Every QR text found in desktop luma frames (clipboard or screen capture). */
export function decodeLumaFrames(frames: MfaLumaFrame[]): Promise<string[]> {
  return decodeAll(frames, "I420");
}

/** Every QR text found in an RGBA image (still image, not a camera frame). */
export function decodeRgbaImage(image: RgbaImage): Promise<string[]> {
  return decodeAll([image]);
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function loadImageSource(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/** Rasterise an image file/blob (PNG, JPEG, GIF, WebP, BMP…) to RGBA. */
export async function blobToRgba(blob: Blob): Promise<RgbaImage> {
  const loaded = await loadImageSource(blob);
  try {
    const size = scaledSize(loaded.width, loaded.height, MAX_DECODE_SIDE);
    const canvas = createCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas 2D context unavailable");
    // White background so transparent QR images keep light quiet zones.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(loaded.source, 0, 0, size.width, size.height);
    const data = ctx.getImageData(0, 0, size.width, size.height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    loaded.release();
  }
}

export async function decodeImageBlob(blob: Blob): Promise<string[]> {
  return decodeRgbaImage(await blobToRgba(blob));
}

/**
 * Decode one camera frame; returns `null` when no QR is visible. Uses the
 * fast single-code path so a live loop stays responsive.
 */
export async function decodeVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const size = scaledSize(video.videoWidth, video.videoHeight, CAMERA_DECODE_WIDTH);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, size.width, size.height);
  const frame = ctx.getImageData(0, 0, size.width, size.height);
  const { decodeQR } = await loadQrDecoder();
  try {
    return decodeQR({ width: frame.width, height: frame.height, data: frame.data });
  } catch {
    return null;
  }
}
