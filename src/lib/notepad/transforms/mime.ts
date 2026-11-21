export type MimeTransformKind =
  | "b64e"
  | "b64d"
  | "urle"
  | "urld"
  | "qpe"
  | "qpd"
  | "a2h"
  | "h2a"
  | "a2d"
  | "d2a"
  | "a2b"
  | "b2a";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/\s+/g, "");
  if (!cleaned) return new Uint8Array(0);
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error("Invalid Base64 input");
  }
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function encodeQuotedPrintable(input: string): string {
  const bytes = textEncoder.encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 10 || b === 13 || (b >= 32 && b <= 126 && b !== 61)) {
      out += String.fromCharCode(b);
    } else {
      out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function decodeQuotedPrintable(input: string): string {
  const stripped = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] === "=") {
      const hex = stripped.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error(`Invalid Quoted-Printable escape at offset ${i}`);
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff);
    }
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

/** Run MIME / Radix transform; throws a descriptive error on invalid encoded input. */
export function runMimeTransform(kind: MimeTransformKind, input: string): string {
  switch (kind) {
    case "b64e":
      return bytesToBase64(textEncoder.encode(input));
    case "b64d":
      return textDecoder.decode(base64ToBytes(input));
    case "urle":
      return encodeURIComponent(input);
    case "urld":
      return decodeURIComponent(input);
    case "qpe":
      return encodeQuotedPrintable(input);
    case "qpd":
      return decodeQuotedPrintable(input);
    case "a2h":
      return [...textEncoder.encode(input)]
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
    case "h2a": {
      const tokens = input.trim() ? input.trim().split(/\s+/) : [];
      const bytes = tokens.map((tok) => {
        if (!/^[0-9A-Fa-f]{1,2}$/.test(tok)) throw new Error(`Invalid hex byte "${tok}"`);
        return Number.parseInt(tok, 16);
      });
      return textDecoder.decode(new Uint8Array(bytes));
    }
    case "a2d":
      return [...textEncoder.encode(input)].map((b) => String(b)).join(" ");
    case "d2a": {
      const tokens = input.trim() ? input.trim().split(/\s+/) : [];
      const bytes = tokens.map((tok) => {
        if (!/^\d+$/.test(tok)) throw new Error(`Invalid decimal byte "${tok}"`);
        const num = Number.parseInt(tok, 10);
        if (num < 0 || num > 255) throw new Error(`Byte out of range: ${num}`);
        return num;
      });
      return textDecoder.decode(new Uint8Array(bytes));
    }
    case "a2b":
      return [...textEncoder.encode(input)].map((b) => b.toString(2).padStart(8, "0")).join(" ");
    case "b2a": {
      const tokens = input.trim() ? input.trim().split(/\s+/) : [];
      const bytes = tokens.map((tok) => {
        if (!/^[01]{1,8}$/.test(tok)) throw new Error(`Invalid binary byte "${tok}"`);
        return Number.parseInt(tok, 2);
      });
      return textDecoder.decode(new Uint8Array(bytes));
    }
  }
}

/** Redact every non-newline character in `input` with `glyph` (`█` or `●`). */
export function redactText(input: string, glyph: "█" | "●" = "█"): string {
  return input.replace(/[^\r\n]/g, glyph);
}

/** Format a Date using Notepad custom format tokens (`yyyy`, `MM`, `dd`, `HH`, `mm`, `ss`). */
export function formatDateTimeCustom(format: string, date: Date = new Date()): string {
  const pad = (val: number, len = 2) => String(val).padStart(len, "0");
  return format
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/dd/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()))
    .replace(/ss/g, pad(date.getSeconds()));
}
