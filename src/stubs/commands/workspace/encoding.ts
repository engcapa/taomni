import { vfsReadBytes, vfsStat } from "../../localVfs";
import { joinWorkspacePath, relativeWorkspacePath } from "./paths";

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizedStubEncoding(label: string): string {
  return label.trim().replace(/_/g, "-").toLowerCase();
}

export function decodeStubBytes(raw: Uint8Array, label: string): { text: string; bom: boolean; encoding: string; } {
  const normalized = normalizedStubEncoding(label);
  let bytes = raw;
  let bom = false;
  if (normalized === "utf-8" && bytes.length >= 3
    && bytes.slice(0, 3).every((byte, index) => byte === [0xef, 0xbb, 0xbf][index])) {
    bytes = bytes.slice(3);
    bom = true;
  } else if (normalized === "utf-16le" && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bytes = bytes.slice(2);
    bom = true;
  } else if (normalized === "utf-16be" && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bytes = bytes.slice(2);
    bom = true;
  }
  const decoderLabel = normalized === "gbk" ? "gbk" : normalized;
  let text: string;
  try {
    text = new TextDecoder(decoderLabel, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Browser preview cannot decode ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { text, bom, encoding: label.trim() || "UTF-8" };
}

export function encodeStubText(text: string, label: string, bom: boolean): Uint8Array {
  const normalized = normalizedStubEncoding(label);
  let bytes: Uint8Array;
  if (normalized === "utf-8") {
    bytes = new TextEncoder().encode(text);
  } else if (normalized === "utf-16le" || normalized === "utf-16be") {
    const output = new Uint8Array(text.length * 2);
    let offset = 0;
    for (const unit of text) {
      const codePoint = unit.codePointAt(0)!;
      const units = codePoint > 0xffff
        ? [0xd800 + ((codePoint - 0x10000) >> 10), 0xdc00 + ((codePoint - 0x10000) & 0x3ff)]
        : [codePoint];
      for (const value of units) {
        if (normalized === "utf-16le") {
          output[offset++] = value & 0xff;
          output[offset++] = value >> 8;
        } else {
          output[offset++] = value >> 8;
          output[offset++] = value & 0xff;
        }
      }
    }
    bytes = output.slice(0, offset);
  } else {
    throw new Error(`Browser preview cannot encode ${label}; use the desktop app for legacy charsets`);
  }
  if (!bom) return bytes;
  const marker = normalized === "utf-8"
    ? [0xef, 0xbb, 0xbf]
    : normalized === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff];
  const result = new Uint8Array(marker.length + bytes.length);
  result.set(marker);
  result.set(bytes, marker.length);
  return result;
}

export async function readStubWorkspaceEncodedFile(
  path: string,
  repoRoot: string | null,
  encoding: string,
): Promise<{ filePath: string; bytes: Uint8Array; text: string; bom: boolean; encoding: string; entry: Awaited<ReturnType<typeof vfsStat>>; }> {
  const target = repoRoot ? joinWorkspacePath(repoRoot, path) : path;
  const [entry, arrayBuffer] = await Promise.all([vfsStat(target), vfsReadBytes(target)]);
  const bytes = new Uint8Array(arrayBuffer);
  const decoded = decodeStubBytes(bytes, encoding);
  return {
    filePath: repoRoot ? relativeWorkspacePath(repoRoot, entry.path) : entry.path,
    bytes,
    text: decoded.text,
    bom: decoded.bom,
    encoding: decoded.encoding,
    entry,
  };
}
