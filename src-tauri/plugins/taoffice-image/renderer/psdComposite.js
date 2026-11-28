import { imageError, pixelThumbnail, previewSizeError, validDimensions } from "./previewRaster.js";

const CHANNELS_BY_MODE = new Map([
  [1, 1], // Grayscale
  [3, 3], // RGB
]);
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

function invalidImage() {
  return imageError("psd-format", "The Photoshop composite image data is damaged.");
}

function unpackRow(source, target) {
  let read = 0;
  let write = 0;
  while (read < source.length) {
    const command = source[read++];
    if (command === 128) continue;
    if (command < 128) {
      const count = command + 1;
      if (count > source.length - read || count > target.length - write) throw invalidImage();
      target.set(source.subarray(read, read + count), write);
      read += count;
      write += count;
    } else {
      const count = 257 - command;
      if (read === source.length || count > target.length - write) throw invalidImage();
      target.fill(source[read++], write, write + count);
      write += count;
    }
  }
  if (write !== target.length) throw invalidImage();
}

function packBitsRows(input, header, samples) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const rowLength = header.width * samples;
  const count = header.height * header.channels;
  let cursor = count * 2;
  if (cursor > input.length) throw invalidImage();
  const offsets = new Uint32Array(count + 1);
  for (let index = 0; index < count; index++) {
    offsets[index] = cursor;
    cursor += view.getUint16(index * 2);
    if (cursor > input.length) throw invalidImage();
  }
  offsets[count] = cursor;

  const rows = new Map();
  return (channel, row) => {
    const index = channel * header.height + row;
    let state = rows.get(channel);
    if (!state) {
      state = { index: -1, data: new Uint8Array(rowLength) };
      rows.set(channel, state);
    }
    if (state.index !== index) {
      unpackRow(input.subarray(offsets[index], offsets[index + 1]), state.data);
      state.index = index;
    }
    return state.data;
  };
}

async function inflateComposite(input, length, signal) {
  if (length > MAX_INFLATED_BYTES) throw previewSizeError();
  if (typeof DecompressionStream !== "function") {
    throw imageError("psd-no-preview", "This WebView cannot read the Photoshop ZIP composite.");
  }
  const bytes = new Uint8Array(length);
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  try {
    let offset = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        if (offset !== bytes.length) throw invalidImage();
        return bytes;
      }
      if (value.byteLength > bytes.length - offset) throw invalidImage();
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    signal?.throwIfAborted();
    throw error.code ? error : invalidImage();
  } finally {
    reader.releaseLock();
  }
}

function undoPrediction(bytes, width, samples) {
  const rowLength = width * samples;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let row = 0; row < bytes.length; row += rowLength) {
    if (samples === 2) {
      for (let offset = row + 2; offset < row + rowLength; offset += 2) {
        view.setUint16(offset, view.getUint16(offset) + view.getUint16(offset - 2));
      }
    } else {
      for (let offset = row + 1; offset < row + rowLength; offset++) bytes[offset] += bytes[offset - 1];
    }
  }
}

async function compositeRows(input, header, compression, samples, signal) {
  if (compression === 1) return packBitsRows(input, header, samples);
  const rowLength = header.width * samples;
  const length = rowLength * header.height * header.channels;
  const bytes = compression === 0 ? input : await inflateComposite(input, length, signal);
  if (bytes.length < length) throw invalidImage();
  if (compression === 3) undoPrediction(bytes, header.width, samples);
  return (channel, row) => {
    const offset = (channel * header.height + row) * rowLength;
    return bytes.subarray(offset, offset + rowLength);
  };
}

export async function decodeComposite(input, header, compression, signal) {
  const colors = CHANNELS_BY_MODE.get(header.mode);
  if (!colors || header.channels < colors || ![8, 16].includes(header.depth) || compression > 3) {
    throw imageError("psd-no-preview", "This Photoshop file contains no supported thumbnail or composite image.");
  }
  const { width, height } = header;
  if (!validDimensions(width, height)) throw previewSizeError();
  const samples = header.depth / 8;
  const readRow = await compositeRows(input, header, compression, samples, signal);
  signal?.throwIfAborted();
  let cachedY = -1;
  let rows;
  const count = colors + (header.transparent && header.channels > colors ? 1 : 0);
  return pixelThumbnail(width, height, 1, (x, y, rgba, index) => {
    if (y !== cachedY) {
      rows = Array.from({ length: count }, (_, channel) => readRow(channel, y));
      cachedY = y;
    }
    const offset = x * samples;
    const alpha = rows[colors]?.[offset] ?? 255;
    // The merged RGB and gray channels were composited over white.
    const restore = alpha > 0 && alpha < 255;
    for (let component = 0; component < 3; component++) {
      const value = rows[colors === 3 ? component : 0][offset];
      rgba[index + component] = restore ? (value + alpha - 255) * 255 / alpha : value;
    }
    rgba[index + 3] = alpha;
  });
}
