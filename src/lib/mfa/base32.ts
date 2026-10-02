// RFC 4648 Base32 as used by otpauth secrets. Mirrors decode_base32 in
// src-tauri/src/mfa/otp.rs: case-insensitive, spaces/hyphens/padding ignored.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Same floor as the backend (80 bits / 16 characters). */
export const MIN_SECRET_BYTES = 10;

/** Uppercase and strip separators; does not validate. */
export function normalizeBase32(input: string): string {
  return input.replace(/[\s\-=]/g, "").toUpperCase();
}

export function decodeBase32(input: string): Uint8Array {
  const clean = normalizeBase32(input);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`invalid Base32 character "${ch}"`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export type SecretProblem = "empty" | "invalid" | "short";

/** Field-level validation used by the add form before calling the backend. */
export function secretProblem(input: string): SecretProblem | null {
  const clean = normalizeBase32(input);
  if (!clean) return "empty";
  let bytes: Uint8Array;
  try {
    bytes = decodeBase32(clean);
  } catch {
    return "invalid";
  }
  return bytes.length < MIN_SECRET_BYTES ? "short" : null;
}
