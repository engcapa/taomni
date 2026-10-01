// Test-only builders (Vitest and the browser stub tests). Not imported by app
// code: it pulls in the `qr` encoder.

import encodeQR from "qr";
import type { MfaLumaFrame } from "./types";

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

const lenField = (field: number, bytes: number[]) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const intField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const utf8 = (value: string) => [...new TextEncoder().encode(value)];

export interface MigrationFixture {
  secret: number[];
  name: string;
  issuer: string;
  /** 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5. */
  algorithm: number;
  /** 1 six, 2 eight. */
  digits: number;
  /** 1 HOTP, 2 TOTP. */
  type: number;
  counter?: number;
}

/** Google Authenticator `otpauth-migration://offline?data=` link. */
export function migrationLink(entries: MigrationFixture[]): string {
  const payload = entries.flatMap((entry) =>
    lenField(1, [
      ...lenField(1, entry.secret),
      ...lenField(2, utf8(entry.name)),
      ...lenField(3, utf8(entry.issuer)),
      ...intField(4, entry.algorithm),
      ...intField(5, entry.digits),
      ...intField(6, entry.type),
      ...intField(7, entry.counter ?? 0),
      // Unknown field 9: readers must skip it.
      ...intField(9, 1),
    ]),
  );
  const bytes = [...payload, ...intField(2, 1), ...intField(3, 1), ...intField(4, 0), ...intField(5, 4242)];
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...bytes)))}`;
}

/** Render `text` as a black-on-white QR luma frame. */
export function qrLumaFrame(text: string, scale = 4, border = 4): MfaLumaFrame {
  // The raw matrix already includes `border` light quiet-zone modules.
  const modules = encodeQR(text, "raw", { border });
  const size = modules.length * scale;
  const data = new Uint8Array(size * size).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1) {
        const offset = (y * scale + dy) * size + x * scale;
        data.fill(0, offset, offset + scale);
      }
    }),
  );
  return { width: size, height: size, data };
}

/** Same QR as RGBA, optionally placed on a larger canvas at an offset. */
export function qrRgba(text: string, canvas?: { width: number; height: number; x: number; y: number }) {
  const frame = qrLumaFrame(text);
  const width = canvas?.width ?? frame.width;
  const height = canvas?.height ?? frame.height;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const value = frame.data[y * frame.width + x];
      const offset = ((y + (canvas?.y ?? 0)) * width + x + (canvas?.x ?? 0)) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  return { width, height, data };
}
