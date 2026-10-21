import { countNullBytes } from "./shared";

export const MAX_IMPORT_ARCHIVE_BYTES = 50_000_000;


export interface ZipTextEntry {
  name: string;
  text: string;
}


export interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}


export async function readZipTextEntries(
  bytes: Uint8Array,
  matches: (name: string) => boolean,
  warnings: string[],
): Promise<ZipTextEntry[]> {
  const entries = parseZipCentralDirectory(bytes);
  const out: ZipTextEntry[] = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    if (entry.isDirectory || !matches(entry.name)) continue;
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_IMPORT_ARCHIVE_BYTES) {
      warnings.push("Skipped remaining ZIP entries because the expanded archive is too large.");
      break;
    }

    try {
      const data = await inflateZipEntry(bytes, entry);
      out.push({ name: entry.name, text: decodeImportedText(data) });
    } catch (error) {
      warnings.push(`Skipped "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return out;
}


export function parseZipCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] {
  const eocdOffset = findZipEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error("The selected file is not a valid ZIP archive.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const entries: ZipCentralEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The ZIP central directory is malformed.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("The ZIP central directory is malformed.");
    const name = decodeZipName(bytes.slice(nameStart, nameEnd), flags);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}


export function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}


export async function inflateZipEntry(bytes: Uint8Array, entry: ZipCentralEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error("local header is malformed");
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new Error("entry data is truncated");
  const compressed = bytes.slice(dataStart, dataEnd);

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawWithDecompressionStream(compressed);
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}


export async function inflateRawWithDecompressionStream(bytes: Uint8Array): Promise<Uint8Array> {
  const Decompression = globalThis.DecompressionStream;
  if (typeof Decompression !== "function") {
    throw new Error("this runtime cannot decompress deflated ZIP entries");
  }

  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([source]).stream().pipeThrough(new Decompression("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}


export function decodeZipName(bytes: Uint8Array, flags: number): string {
  const encoding = (flags & 0x0800) !== 0 ? "utf-8" : "windows-1252";
  try {
    return new TextDecoder(encoding).decode(bytes).replace(/\\/g, "/");
  } catch {
    return new TextDecoder("utf-8").decode(bytes).replace(/\\/g, "/");
  }
}


export function decodeImportedText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2));
  }
  // Xshell .xsh files are UTF-16 LE and usually carry a BOM (handled above),
  // but fall back to a null-byte heuristic for BOM-less UTF-16 content.
  if (bytes.length >= 2 && countNullBytes(bytes) > bytes.length / 8) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}
