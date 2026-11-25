import {
  VFS_ROOT,
  basenameOf,
  parentOf,
  vfsList,
  vfsMkdir,
  vfsReadBytes,
  vfsRemove,
  vfsRename,
  vfsStat,
  vfsWriteBytes,
} from "../localVfs";

const BACKUP_STORAGE_KEY = "taomni.stub.notepad.backups.v1";
const MACROS_STORAGE_KEY = "taomni.stub.notepad.macros.v1";
const MACROS_HASH_KEY = "taomni.stub.notepad.macros.sha256.v1";
const SESSION_STORAGE_KEY = "taomni.stub.notepad.sessions.v1";
const READONLY_STORAGE_KEY = "taomni.stub.notepad.readonly.v1";

interface StubBackupRecord {
  entry: {
    id: string;
    docId: string;
    path: string | null;
    name: string;
    encoding: string;
    bom: boolean;
    eol: string;
    savedHash: string;
    updatedAt: number;
    size: number;
  };
  content: string;
}

function normalizeEol(content: string, eol: string): string {
  const lf = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  switch (eol.toUpperCase()) {
    case "LF":
      return lf;
    case "CRLF":
      return lf.replace(/\n/g, "\r\n");
    case "CR":
      return lf.replace(/\n/g, "\r");
    default:
      throw new Error(`unsupported: Unsupported line ending: ${eol}`);
  }
}

function encodeUtf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const bomBytes = bom ? 2 : 0;
  const out = new Uint8Array(bomBytes + text.length * 2);
  let offset = 0;
  if (bom) {
    out[0] = littleEndian ? 0xff : 0xfe;
    out[1] = littleEndian ? 0xfe : 0xff;
    offset = 2;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (littleEndian) {
      out[offset++] = code & 0xff;
      out[offset++] = (code >> 8) & 0xff;
    } else {
      out[offset++] = (code >> 8) & 0xff;
      out[offset++] = code & 0xff;
    }
  }
  return out;
}

function encodeStubBytes(content: string, encoding: string, bom: boolean): Uint8Array {
  const clean = encoding.trim().toUpperCase();
  if (clean === "UTF-16LE") return encodeUtf16(content, true, bom);
  if (clean === "UTF-16BE") return encodeUtf16(content, false, bom);
  const body = new TextEncoder().encode(content);
  if (clean === "UTF-8 BOM" || (clean === "UTF-8" && bom)) {
    const out = new Uint8Array(3 + body.byteLength);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
  }
  return body;
}

function md5Hex(bytes: Uint8Array): string {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) >>> 0;
      const rot = (sum << S[i]) | (sum >>> (32 - S[i]));
      B = (B + rot) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return Array.from(new Uint8Array(out.buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function digestHex(algorithm: string, bytes: Uint8Array): Promise<string> {
  const norm = algorithm.trim().toLowerCase();
  if (norm === "md5") return md5Hex(bytes);
  const algoMap: Record<string, string> = {
    sha1: "SHA-1",
    "sha-1": "SHA-1",
    sha256: "SHA-256",
    "sha-256": "SHA-256",
    sha512: "SHA-512",
    "sha-512": "SHA-512",
  };
  const subtleName = algoMap[norm];
  if (!subtleName) throw new Error(`unsupported: Unsupported hash algorithm: ${algorithm}`);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest(subtleName, copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors in browser preview
  }
}

async function ensureParentDirs(path: string): Promise<void> {
  const parts = parentOf(path).split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += `/${part}`;
    try {
      await vfsStat(cur);
    } catch {
      await vfsMkdir(cur);
    }
  }
}

const ENCODING_GROUPS = [
  { group: "Unicode", encodings: ["UTF-8", "UTF-8 BOM", "UTF-16LE", "UTF-16BE"] },
  { group: "East Asian ANSI", encodings: ["GBK", "GB18030", "Big5", "Shift_JIS", "EUC-JP", "EUC-KR"] },
  { group: "Western / Latin", encodings: ["windows-1252", "ISO-8859-1", "ISO-8859-15", "windows-1250"] },
  { group: "Cyrillic / Greek", encodings: ["windows-1251", "KOI8-R", "ISO-8859-5", "windows-1253"] },
];

export async function invokeNotepad(cmd: string, args: Record<string, any> = {}): Promise<unknown> {
  switch (cmd) {
    case "viewer_save_as": {
      const path = String(args.path ?? "");
      if (!path.startsWith("/")) {
        throw new Error("permission: Notepad target path must be absolute");
      }
      if (!args.overwrite) {
        try {
          await vfsStat(path);
          throw new Error("exists: Target file already exists");
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("exists:")) throw err;
        }
      }
      await ensureParentDirs(path);
      const normalized = normalizeEol(String(args.content ?? ""), String(args.eol ?? "LF"));
      const encoded = encodeStubBytes(normalized, String(args.encoding ?? "UTF-8"), Boolean(args.bom));
      const buf = new Uint8Array(encoded).buffer;
      await vfsWriteBytes(path, buf);
      const hash = await digestHex("sha256", encoded);
      return { path, hash, size: encoded.byteLength, mtime: Math.floor(Date.now() / 1000) };
    }
    case "viewer_rename": {
      const oldPath = String(args.oldPath ?? "");
      const newName = String(args.newName ?? "").trim();
      if (!newName || newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
        throw new Error("invalid_name: Invalid file name");
      }
      const parent = parentOf(oldPath) || VFS_ROOT;
      const newPath = `${parent}/${newName}`;
      if (newPath !== oldPath) {
        try {
          await vfsStat(newPath);
          throw new Error("exists: A file with that name already exists");
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("exists:")) throw err;
        }
        await vfsRename(oldPath, newPath);
      }
      return { oldPath, newPath, name: newName };
    }
    case "viewer_trash": {
      const path = String(args.path ?? "");
      await vfsStat(path);
      await vfsRemove(path, false);
      return path;
    }
    case "viewer_set_readonly_attr": {
      const path = String(args.path ?? "");
      const readonly = Boolean(args.readonly);
      const map = readJsonStorage<Record<string, boolean>>(READONLY_STORAGE_KEY, {});
      map[path] = readonly;
      writeJsonStorage(READONLY_STORAGE_KEY, map);
      return readonly;
    }
    case "viewer_write_text_elevated":
      throw new Error("unsupported: Elevated save is not available in browser preview");
    case "notepad_open_terminal_dir":
      throw new Error("unsupported: Opening a system terminal is not available in browser preview");
    case "notepad_list_dir_text_files": {
      const path = String(args.path ?? VFS_ROOT);
      const cap = Math.max(1, Math.min(100, Number(args.maxCount ?? 20)));
      const entries = await vfsList(path, true);
      const files: string[] = [];
      let totalCandidates = 0;
      let skippedBinary = 0;
      let truncated = false;
      for (const entry of entries) {
        if (entry.fileType !== "file") continue;
        totalCandidates += 1;
        const bytes = new Uint8Array(await vfsReadBytes(entry.path));
        const hasNul = bytes.slice(0, 4096).some((b) => b === 0);
        if (hasNul) {
          skippedBinary += 1;
          continue;
        }
        if (files.length >= cap) {
          truncated = true;
          continue;
        }
        files.push(entry.path);
      }
      return { files, totalCandidates, skippedBinary, truncated };
    }
    case "notepad_backup_write": {
      const all = readJsonStorage<Record<string, StubBackupRecord[]>>(BACKUP_STORAGE_KEY, {});
      const docId = String(args.docId ?? "");
      const content = String(args.content ?? "");
      const id = `${docId}__${Date.now()}`;
      const record: StubBackupRecord = {
        entry: {
          id,
          docId,
          path: args.path ?? null,
          name: String(args.name ?? "Untitled"),
          encoding: String(args.encoding ?? "UTF-8"),
          bom: Boolean(args.bom),
          eol: String(args.eol ?? "LF"),
          savedHash: String(args.savedHash ?? ""),
          updatedAt: Math.floor(Date.now() / 1000),
          size: content.length,
        },
        content,
      };
      const list = (all[docId] ?? []).slice(-9);
      list.push(record);
      all[docId] = list;
      writeJsonStorage(BACKUP_STORAGE_KEY, all);
      return record.entry;
    }
    case "notepad_backup_list": {
      const all = readJsonStorage<Record<string, StubBackupRecord[]>>(BACKUP_STORAGE_KEY, {});
      return Object.values(all)
        .map((list) => list[list.length - 1]?.entry)
        .filter((e): e is StubBackupRecord["entry"] => Boolean(e))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    case "notepad_backup_read": {
      const all = readJsonStorage<Record<string, StubBackupRecord[]>>(BACKUP_STORAGE_KEY, {});
      const id = String(args.id ?? "");
      for (const list of Object.values(all)) {
        const found = list.find((item) => item.entry.id === id);
        if (found) return found;
      }
      throw new Error(`not_found: Backup not found: ${id}`);
    }
    case "notepad_backup_prune": {
      const all = readJsonStorage<Record<string, StubBackupRecord[]>>(BACKUP_STORAGE_KEY, {});
      delete all[String(args.docId ?? "")];
      writeJsonStorage(BACKUP_STORAGE_KEY, all);
      return undefined;
    }
    case "notepad_save_backup_copy": {
      const mode = String(args.mode ?? "none");
      if (mode === "none") return null;
      const sourcePath = String(args.sourcePath ?? "");
      const bytes = await vfsReadBytes(sourcePath);
      const dir = String(args.customDir || `${VFS_ROOT}/.notepad-backups`);
      await ensureParentDirs(`${dir}/placeholder`);
      try { await vfsStat(dir); } catch { await vfsMkdir(dir); }
      const name = basenameOf(sourcePath) || "file.txt";
      const dest = mode === "verbose" ? `${dir}/${name}.${Date.now()}.bak` : `${dir}/${name}.bak`;
      await vfsWriteBytes(dest, bytes);
      return dest;
    }
    case "notepad_hash": {
      const algorithm = String(args.algorithm ?? "sha256").toLowerCase();
      let bytes: Uint8Array;
      if (args.filePath) {
        bytes = new Uint8Array(await vfsReadBytes(String(args.filePath)));
      } else {
        bytes = new TextEncoder().encode(String(args.text ?? ""));
      }
      return { algorithm, hex: await digestHex(algorithm, bytes) };
    }
    case "notepad_list_encodings":
      return ENCODING_GROUPS;
    case "notepad_check_encoding_loss": {
      const content = String(args.content ?? "");
      const encoding = String(args.encodingLabel ?? "UTF-8");
      const upper = encoding.trim().replace(/ BOM$/i, "").toUpperCase();
      if (upper === "UTF-8" || upper === "UTF-16LE" || upper === "UTF-16BE" || upper === "UTF-16") {
        return { encoding, unrepresentableCount: 0, samples: [] };
      }
      const isEastAsian = ["GBK", "GB18030", "BIG5", "SHIFT_JIS", "EUC-JP", "EUC-KR"].includes(upper);
      let count = 0;
      const samples: string[] = [];
      for (const ch of content) {
        const cp = ch.codePointAt(0) ?? 0;
        const bad = isEastAsian ? cp > 0xffff : cp > 0xff;
        if (bad) {
          count += 1;
          if (samples.length < 5 && !samples.includes(ch)) samples.push(ch);
        }
      }
      return { encoding, unrepresentableCount: count, samples };
    }
    case "notepad_macros_load":
    case "notepad_macros_validate": {
      const json = localStorage.getItem(MACROS_STORAGE_KEY) ?? "[]";
      const actualHash = await digestHex("sha256", new TextEncoder().encode(json));
      const expectedHash = localStorage.getItem(MACROS_HASH_KEY) ?? (localStorage.getItem(MACROS_STORAGE_KEY) ? "" : actualHash);
      return {
        json,
        expectedHash,
        actualHash,
        tampered: expectedHash.toLowerCase() !== actualHash.toLowerCase(),
      };
    }
    case "notepad_macros_save": {
      const json = String(args.json ?? "[]");
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) throw new Error("invalid_json: macros.json must be a JSON array");
      const actualHash = await digestHex("sha256", new TextEncoder().encode(json));
      localStorage.setItem(MACROS_STORAGE_KEY, json);
      localStorage.setItem(MACROS_HASH_KEY, actualHash);
      return { json, expectedHash: actualHash, actualHash, tampered: false };
    }
    case "notepad_macros_accept": {
      const json = localStorage.getItem(MACROS_STORAGE_KEY) ?? "[]";
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) throw new Error("invalid_json: macros.json must be a JSON array");
      const actualHash = await digestHex("sha256", new TextEncoder().encode(json));
      localStorage.setItem(MACROS_HASH_KEY, actualHash);
      return { json, expectedHash: actualHash, actualHash, tampered: false };
    }
    case "notepad_session_save": {
      const json = String(args.json ?? "");
      const parsed = JSON.parse(json) as { version?: unknown };
      if (typeof parsed.version !== "number") {
        throw new Error("invalid_json: Session JSON must include numeric version");
      }
      const sessions = readJsonStorage<Record<string, string>>(SESSION_STORAGE_KEY, {});
      const target = args.filePath ? String(args.filePath) : "__last__";
      sessions[target] = json;
      writeJsonStorage(SESSION_STORAGE_KEY, sessions);
      return target;
    }
    case "notepad_session_load": {
      const sessions = readJsonStorage<Record<string, string>>(SESSION_STORAGE_KEY, {});
      const target = args.filePath ? String(args.filePath) : "__last__";
      const found = sessions[target] ?? null;
      if (!found && args.filePath) throw new Error("not_found: Session file does not exist");
      return found;
    }
    default:
      throw new Error(`unsupported: Unknown notepad command: ${cmd}`);
  }
}

export function stubIsReadonlyPath(path: string): boolean {
  const map = readJsonStorage<Record<string, boolean>>(READONLY_STORAGE_KEY, {});
  return Boolean(map[path]);
}
