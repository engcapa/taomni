const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 16_384;
const THUMBNAIL_EDGE = 2048;
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2]);
const MAX_JPEG_SEGMENTS = 4096;

export function imageError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function previewSizeError() {
  return imageError("image-preview-size", "The image exceeds the preview size limit.");
}

export function validateInput(bytes, signal) {
  signal?.throwIfAborted();
  if (bytes.byteLength > MAX_INPUT_BYTES) throw previewSizeError();
}

export function validDimensions(width, height) {
  return width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}

export function thumbnailSize(width, height) {
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Inspect the data before handing it to the WebView's decoder. Camera sensor
// streams can also start with a JPEG marker, but use lossless frames.
export function inspectJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const exif = [];
  let dimensions;
  let offset = 2;
  for (let segment = 0; segment < MAX_JPEG_SEGMENTS && bytes[offset] === 0xff; segment++) {
    const start = offset++;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || offset + 2 > bytes.length) break;
    const length = data.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) break;
    if (marker === 0xda) return dimensions && { ...dimensions, exif };
    if (marker === 0xe1 && length >= 8 && data.getUint32(offset + 2) === 0x45786966
      && data.getUint16(offset + 6) === 0) exif.push([start, offset + length]);
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8) break;
      const height = data.getUint16(offset + 3);
      const width = data.getUint16(offset + 5);
      if (!width || !height || ![1, 3, 4].includes(bytes[offset + 7])) break;
      dimensions = { width, height };
    }
    offset += length;
  }
  return undefined;
}

function jpegBlob(bytes, exif) {
  const chunks = [];
  let offset = 0;
  for (const [start, end] of exif) {
    chunks.push(bytes.subarray(offset, start));
    offset = end;
  }
  chunks.push(bytes.subarray(offset));
  return new Blob(chunks, { type: "image/jpeg" });
}

export async function decodeJpeg(bytes, metadata, orientation, signal) {
  if (!validDimensions(metadata.width, metadata.height)) throw previewSizeError();
  signal?.throwIfAborted();
  // RAW/TIFF orientations describe the container's image. Strip JPEG Exif in that
  // case, so an automatically applied JPEG orientation cannot rotate it twice.
  const blob = jpegBlob(bytes, orientation === undefined ? [] : metadata.exif);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal?.throwIfAborted();
    if (!validDimensions(image.naturalWidth, image.naturalHeight)) throw previewSizeError();
    return await canvasThumbnail(
      image.naturalWidth, image.naturalHeight, orientation ?? 1,
      (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const orientationTransforms = {
  2: (width) => [-1, 0, 0, 1, width, 0],
  3: (width, height) => [-1, 0, 0, -1, width, height],
  4: (_width, height) => [1, 0, 0, -1, 0, height],
  5: () => [0, 1, 1, 0, 0, 0],
  6: (_width, height) => [0, 1, -1, 0, height, 0],
  7: (width, height) => [0, -1, -1, 0, height, width],
  8: (width) => [0, -1, 1, 0, 0, width],
};

export async function canvasThumbnail(sourceWidth, sourceHeight, orientation, draw) {
  const size = thumbnailSize(sourceWidth, sourceHeight);
  const transpose = orientation >= 5 && orientation <= 8;
  const canvas = document.createElement("canvas");
  canvas.width = transpose ? size.height : size.width;
  canvas.height = transpose ? size.width : size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare the image preview.");
  const transform = orientationTransforms[orientation];
  if (transform) ctx.setTransform(...transform(size.width, size.height));
  try {
    draw(ctx, size.width, size.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not render the image preview.");
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function pixelThumbnail(sourceWidth, sourceHeight, orientation, getPixel) {
  return canvasThumbnail(sourceWidth, sourceHeight, orientation, (ctx, width, height) => {
    const pixels = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const sourceY = Math.floor((y + 0.5) * sourceHeight / height);
      for (let x = 0; x < width; x++) {
        const sourceX = Math.floor((x + 0.5) * sourceWidth / width);
        const offset = (y * width + x) * 4;
        getPixel(sourceX, sourceY, pixels.data, offset);
      }
    }
    if (orientation >= 2 && orientation <= 8) {
      // putImageData ignores the orientation transform placed on the context.
      const raster = document.createElement("canvas");
      raster.width = width;
      raster.height = height;
      raster.getContext("2d").putImageData(pixels, 0, 0);
      ctx.drawImage(raster, 0, 0);
      raster.width = 0;
      raster.height = 0;
    } else {
      ctx.putImageData(pixels, 0, 0);
    }
  });
}
