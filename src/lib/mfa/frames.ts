import type { MfaLumaFrame } from "./types";

/** Container written by src-tauri/src/mfa/capture.rs `encode_frames`. */
const MAGIC = [0x54, 0x51, 0x46, 0x31]; // "TQF1"

function toBytes(payload: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return Uint8Array.from(payload);
}

/** `"TQF1"`, u32 count, then per frame u32 width, u32 height and luma bytes. */
export function parseLumaFrames(payload: ArrayBuffer | ArrayBufferView | number[]): MfaLumaFrame[] {
  const bytes = toBytes(payload);
  if (bytes.length < 8 || MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error("MFA_CAPTURE_FAILED: unexpected image payload");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const frames: MfaLumaFrame[] = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > bytes.length) throw new Error("MFA_CAPTURE_FAILED: truncated frame header");
    const width = view.getUint32(offset, true);
    const height = view.getUint32(offset + 4, true);
    offset += 8;
    const length = width * height;
    if (width === 0 || height === 0 || offset + length > bytes.length) {
      throw new Error("MFA_CAPTURE_FAILED: truncated frame data");
    }
    frames.push({ width, height, data: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return frames;
}

/** Inverse of {@link parseLumaFrames}; used by the browser stub and tests. */
export function encodeLumaFrames(frames: MfaLumaFrame[]): Uint8Array {
  const total = 8 + frames.reduce((sum, frame) => sum + 8 + frame.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, frames.length, true);
  let offset = 8;
  for (const frame of frames) {
    view.setUint32(offset, frame.width, true);
    view.setUint32(offset + 4, frame.height, true);
    out.set(frame.data, offset + 8);
    offset += 8 + frame.data.length;
  }
  return out;
}
