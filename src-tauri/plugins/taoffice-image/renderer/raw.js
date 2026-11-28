import {
  decodeJpeg, imageError, inspectJpeg, pixelThumbnail, previewSizeError, validateInput, validDimensions,
} from "./previewRaster.js";
import { nikonJpeg, tiffDirectories } from "./rawTiff.js";

const CAMERA_SENSOR = new Set([32803, 34892]);
const JPEG_COMPRESSION = new Set([6, 7]);
const MAX_CANDIDATES = 48;

function noPreview() {
  return imageError("raw-no-preview", "This camera RAW file contains no supported embedded preview.");
}

function tiffOrientation(value) {
  return value >= 1 && value <= 8 ? value : undefined;
}

function rgbStrips(tiff, directory, width, height) {
  const offsets = directory.values(273);
  const sizes = directory.values(279);
  const rows = directory.first(278) ?? height;
  if (!rows || offsets.length !== sizes.length || offsets.length !== Math.ceil(height / rows)) return undefined;
  const strips = offsets.map((offset, index) => tiff.range(offset, sizes[index]));
  const rowBytes = width * 3;
  if (!strips.every((strip, index) => strip?.length === Math.min(rows, height - index * rows) * rowBytes)) return undefined;
  return { strips, rows, rowBytes };
}

export async function decodeRaw(bytes, signal) {
  validateInput(bytes, signal);
  const tiff = tiffDirectories(bytes);
  if (!tiff) throw imageError("raw-format", "Could not read the camera RAW image directory.");

  const sourceOrientation = tiffOrientation(tiff.root.first(274));
  const candidates = [];
  let overSize = false;

  function addCandidate(width, height, decode) {
    if (!validDimensions(width, height)) {
      overSize = true;
    } else if (candidates.length < MAX_CANDIDATES) {
      candidates.push({ area: width * height, decode });
    }
  }

  function addJpeg(data, orientation) {
    const metadata = data && inspectJpeg(data);
    if (metadata) addCandidate(metadata.width, metadata.height, () => decodeJpeg(data, metadata, orientation, signal));
  }

  addJpeg(nikonJpeg(tiff), sourceOrientation);
  for (const directory of tiff.images()) {
    const photometric = directory.first(262);
    if (CAMERA_SENSOR.has(photometric)) continue;
    const orientation = tiffOrientation(directory.first(274)) ?? sourceOrientation;
    addJpeg(tiff.range(directory.first(513), directory.first(514)), orientation);
    const compression = directory.first(259);
    if (JPEG_COMPRESSION.has(compression)) addJpeg(tiff.range(directory.first(273), directory.first(279)), orientation);

    const width = directory.first(256);
    const height = directory.first(257);
    const depth = directory.values(258, 3);
    if (compression !== 1 || photometric !== 2 || directory.first(277) !== 3
      || (directory.first(284) ?? 1) !== 1 || depth.length !== 3 || !depth.every((bits) => bits === 8)) continue;
    if (!validDimensions(width, height)) {
      overSize ||= width > 0 && height > 0;
      continue;
    }
    const rgb = rgbStrips(tiff, directory, width, height);
    if (!rgb) continue;
    addCandidate(width, height, () => pixelThumbnail(width, height, orientation ?? 1, (x, y, output, target) => {
      const strip = rgb.strips[Math.floor(y / rgb.rows)];
      const offset = (y % rgb.rows) * rgb.rowBytes + x * 3;
      output[target] = strip[offset];
      output[target + 1] = strip[offset + 1];
      output[target + 2] = strip[offset + 2];
      output[target + 3] = 255;
    }));
  }

  candidates.sort((first, second) => second.area - first.area);
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      return await candidate.decode();
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === "image-preview-size") overSize = true;
    }
  }
  throw overSize ? previewSizeError() : noPreview();
}
