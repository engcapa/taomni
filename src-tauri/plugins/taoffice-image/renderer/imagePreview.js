import { decodeHeif } from "./heif.js";
import { decodePsd } from "./psd.js";
import { decodeRaw } from "./raw.js";

const decoders = new Map([
  ["heic", decodeHeif], ["heif", decodeHeif], ["psd", decodePsd],
  ["cr2", decodeRaw], ["nef", decodeRaw], ["arw", decodeRaw], ["dng", decodeRaw],
]);

export async function readImagePreview(source, signal) {
  const decode = decoders.get(source.extension.toLowerCase());
  if (!decode) throw new Error("unsupported");
  const file = await source.read();
  signal.throwIfAborted();
  if (!file.size) throw new Error("empty");
  if (file.size > 32 * 1024 * 1024) throw new Error("size");
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const preview = await decode(bytes, signal);
  signal.throwIfAborted();
  return preview;
}
