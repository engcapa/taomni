import {
  decodeJpeg, imageError, inspectJpeg, pixelThumbnail, previewSizeError, validateInput, validDimensions,
} from "./previewRaster.js";
import { decodeComposite } from "./psdComposite.js";

const PHOTOSHOP = 0x38425053; // 8BPS
const IMAGE_RESOURCE = 0x3842494d; // 8BIM
const THUMBNAIL_RESOURCE = 1036;
const LEGACY_THUMBNAIL_RESOURCE = 1033;
const MAX_RESOURCES = 65_536;

function invalidPsd() {
  return imageError("psd-format", "Could not read this Photoshop file.");
}

function readHeader(view) {
  if (view.byteLength < 26 || view.getUint32(0) !== PHOTOSHOP || view.getUint16(4) !== 1) throw invalidPsd();
  const channels = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  if (!width || !height || channels < 1 || channels > 56) throw invalidPsd();
  return { width, height, channels, depth: view.getUint16(22), mode: view.getUint16(24) };
}

function readSection(view, offset) {
  if (offset > view.byteLength - 4) throw invalidPsd();
  const start = offset + 4;
  const length = view.getUint32(offset);
  if (length > view.byteLength - start) throw invalidPsd();
  return { start, end: start + length, length };
}

function findThumbnails(bytes, view, resources) {
  const thumbnails = new Map();
  let cursor = resources.start;
  for (let count = 0; cursor <= resources.end - 12 && count < MAX_RESOURCES; count++) {
    if (view.getUint32(cursor) !== IMAGE_RESOURCE) break;
    const id = view.getUint16(cursor + 4);
    const nameLength = view.getUint8(cursor + 6);
    const paddedNameLength = (nameLength + 2) & ~1;
    const lengthField = cursor + 6 + paddedNameLength;
    if (lengthField > resources.end - 4) break;
    const start = lengthField + 4;
    const length = view.getUint32(lengthField);
    if (length > resources.end - start) break;
    const end = start + length;
    cursor = end + (length % 2);
    if ((id !== THUMBNAIL_RESOURCE && id !== LEGACY_THUMBNAIL_RESOURCE) || length < 28 || thumbnails.has(id)) continue;
    const format = view.getUint32(start);
    const compressed = view.getUint32(start + 20);
    if ((format !== 0 && format !== 1) || !compressed || compressed > length - 28) continue;
    const data = bytes.subarray(start + 28, start + 28 + compressed);
    thumbnails.set(id, {
      data, format, width: view.getUint32(start + 4), height: view.getUint32(start + 8),
      stride: view.getUint32(start + 12), depth: view.getUint16(start + 24), planes: view.getUint16(start + 26),
      bgr: id === LEGACY_THUMBNAIL_RESOURCE,
    });
  }
  return [thumbnails.get(THUMBNAIL_RESOURCE), thumbnails.get(LEGACY_THUMBNAIL_RESOURCE)].filter(Boolean);
}

async function decodeThumbnail(thumbnail, signal) {
  if (thumbnail.format === 1) {
    const metadata = inspectJpeg(thumbnail.data);
    return metadata && decodeJpeg(thumbnail.data, metadata, undefined, signal);
  }
  const { width, height, stride, data, depth, planes, bgr } = thumbnail;
  if (!width || !height || depth !== 24 || planes !== 1 || stride < width * 3 || stride * height !== data.length) {
    return undefined;
  }
  if (!validDimensions(width, height)) throw previewSizeError();
  return pixelThumbnail(width, height, 1, (x, y, pixels, target) => {
    const offset = y * stride + x * 3;
    pixels[target] = data[offset + (bgr ? 2 : 0)];
    pixels[target + 1] = data[offset + 1];
    pixels[target + 2] = data[offset + (bgr ? 0 : 2)];
    pixels[target + 3] = 255;
  });
}

export async function decodePsd(bytes, signal) {
  validateInput(bytes, signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(view);
  const colorData = readSection(view, 26);
  const resources = readSection(view, colorData.end);
  let oversized = false;
  for (const thumbnail of findThumbnails(bytes, view, resources)) {
    try {
      const preview = await decodeThumbnail(thumbnail, signal);
      if (preview) return preview;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === "image-preview-size") oversized = true;
    }
  }

  const layers = readSection(view, resources.end);
  if (layers.end > view.byteLength - 2) throw invalidPsd();
  const mergedTransparency = layers.length >= 6 && view.getUint32(layers.start) >= 2
    && view.getUint32(layers.start) <= layers.length - 4 && view.getInt16(layers.start + 4) < 0;
  try {
    return await decodeComposite(bytes.subarray(layers.end + 2), { ...header, transparent: mergedTransparency },
      view.getUint16(layers.end), signal);
  } catch (error) {
    if (oversized && error.code === "psd-no-preview") throw previewSizeError();
    throw error;
  }
}
