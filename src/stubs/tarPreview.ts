import type { ArchiveEntry } from "../lib/openFile/archive";
import { getLocale } from "../lib/i18n";

const blockSize = 512;
const maxMember = 32 * 1024 * 1024;
const maxBrowserBytes = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const desktopMessage = () => getLocale() === "zh-CN"
  ? "请在桌面应用中打开此压缩文件。" : "Open this compressed file in the desktop app.";

async function unpack(input: ArrayBuffer, suffix: string): Promise<Uint8Array<ArrayBuffer>> {
  if (suffix === ".tar") return new Uint8Array(input);
  if (suffix !== ".tar.gz" && suffix !== ".tgz" && suffix !== ".gz") throw new Error(desktopMessage());
  return unpackGzip(input, maxBrowserBytes);
}

async function unpackGzip(input: ArrayBuffer, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error(desktopMessage());
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}

export async function compressedDirectory(input: ArrayBuffer, suffix: string, name: string) {
  if (suffix !== ".gz") throw new Error(desktopMessage());
  if (!name || !safePath(name)) throw new Error("Invalid compressed output name");
  const bytes = await unpackGzip(input, maxMember);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const entries: ArchiveEntry[] = [{ index: 0, name, directory: false, size: bytes.length, crc: new DataView(digest).getUint32(0) }];
  return { entries, content: async () => bytes.buffer };
}

function textField(bytes: Uint8Array, start: number, end: number): string {
  const field = bytes.subarray(start, end);
  const nul = field.indexOf(0);
  return utf8.decode(nul < 0 ? field : field.subarray(0, nul));
}

function octal(bytes: Uint8Array, start: number, end: number): number {
  const field = textField(bytes, start, end).trim();
  if (!/^[0-7]+$/.test(field)) throw new Error("Invalid TAR header number");
  return Number.parseInt(field, 8);
}

function safePath(name: string): boolean {
  return name.split("/").every((part) => part && part.length <= 255 &&
    !/[. ]$|[\\:<>"|?*\p{Cc}]|^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(part));
}

/** Browser VFS support for ordinary USTAR; the desktop owns the full decoder. */
export async function tarDirectory(input: ArrayBuffer, suffix: string) {
  const archive = await unpack(input, suffix);
  const entries: ArchiveEntry[] = [];
  const data: Uint8Array[] = [];
  let offset = 0;
  if (archive.length < blockSize) throw new Error("Incomplete TAR archive");
  while (offset + blockSize <= archive.length) {
    const header = archive.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) break;
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header, 148, 156)) throw new Error("Invalid TAR header checksum");
    if (entries.length >= 4096) throw new Error("TAR directory exceeds 4,096 entries");
    const type = header[156];
    const directory = type === 53;
    if (!directory && type !== 0 && type !== 48) {
      if ([103, 120, 76].includes(type)) throw new Error(desktopMessage());
      throw new Error("Archive contains an unsafe path or non-regular entry");
    }
    const size = octal(header, 124, 136);
    const start = offset + blockSize;
    offset = start + Math.ceil(size / blockSize) * blockSize;
    if (offset > archive.length || size > maxMember || (directory && size !== 0)) {
      throw new Error("TAR entry exceeds its available bounds");
    }
    const prefix = textField(header, 257, 263) === "ustar" ? textField(header, 345, 500) : "";
    const raw = (prefix ? prefix + "/" : "") + textField(header, 0, 100);
    const relative = raw.replace(/^(\.\/)+/, "");
    const name = directory ? relative.replace(/\/+$/, "") : relative;
    if (directory && (name === "." || raw === "./")) continue;
    if (!safePath(name)) {
      throw new Error("Archive contains an unsafe path or non-regular entry");
    }
    const bytes = archive.subarray(start, start + size);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    entries.push({ index: entries.length, directory, name, size, crc: new DataView(digest).getUint32(0) });
    data.push(bytes);
  }
  if (archive.subarray(offset).some((byte) => byte !== 0)) throw new Error("Unexpected data after the TAR directory");
  return { entries, content: async (entry: ArchiveEntry) => Uint8Array.from(data[entry.index]).buffer };
}
