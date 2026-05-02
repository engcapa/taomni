/**
 * Browser-only virtual local filesystem for the SFTP browser preview.
 * Files live in IndexedDB so they survive page reloads. The real Tauri build
 * uses the actual OS filesystem instead.
 */

import type { FileEntry, FileType } from "../lib/sftp";

const DB_NAME = "newmob-vfs";
const STORE = "files";
const DB_VERSION = 1;

interface VfsRecord {
  path: string;
  parent: string;
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  data?: ArrayBuffer;
}

const VIRTUAL_ROOT = "/preview";
const SEED_DIRS = [`${VIRTUAL_ROOT}`, `${VIRTUAL_ROOT}/uploads`, `${VIRTUAL_ROOT}/downloads`];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "path" });
        store.createIndex("parent", "parent", { unique: false });
      }
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        await ensureSeed(db);
      } catch (err) {
        console.warn("[localVfs] seed failed:", err);
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function get(store: IDBObjectStore, path: string): Promise<VfsRecord | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(path);
    req.onsuccess = () => resolve(req.result as VfsRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

function put(store: IDBObjectStore, record: VfsRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function del(store: IDBObjectStore, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.delete(path);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function listIndex(store: IDBObjectStore, parent: string): Promise<VfsRecord[]> {
  return new Promise((resolve, reject) => {
    const idx = store.index("parent");
    const req = idx.getAll(parent);
    req.onsuccess = () => resolve((req.result as VfsRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function ensureSeed(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  for (const path of SEED_DIRS) {
    const existing = await get(store, path);
    if (!existing) {
      const parent = parentOf(path);
      const name = basenameOf(path);
      await put(store, {
        path,
        parent,
        name,
        type: "dir",
        size: 0,
        mtime: Math.floor(Date.now() / 1000),
      });
    }
  }
  const readme = `${VIRTUAL_ROOT}/README.txt`;
  const existingReadme = await get(store, readme);
  if (!existingReadme) {
    const text = new TextEncoder().encode(
      "Browser preview uses an in-memory virtual local filesystem.\n" +
        "Drop OS files here or download remote files to persist them in IndexedDB.\n" +
        "The real Tauri build uses your actual OS filesystem.\n",
    );
    await put(store, {
      path: readme,
      parent: VIRTUAL_ROOT,
      name: "README.txt",
      type: "file",
      size: text.byteLength,
      mtime: Math.floor(Date.now() / 1000),
      data: text.buffer,
    });
  }
}

export function parentOf(path: string): string {
  if (!path || path === "/" || path === VIRTUAL_ROOT) return "";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

export function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function normalize(path: string): string {
  if (!path) return VIRTUAL_ROOT;
  if (!path.startsWith("/")) return `${VIRTUAL_ROOT}/${path}`;
  if (path === "/") return VIRTUAL_ROOT;
  return path.replace(/\/+$/, "") || VIRTUAL_ROOT;
}

function recordToEntry(rec: VfsRecord): FileEntry {
  return {
    name: rec.name,
    path: rec.path,
    size: rec.size,
    mtime: rec.mtime,
    mode: rec.type === "dir" ? 0o755 : 0o644,
    fileType: rec.type === "dir" ? "dir" : "file",
    isHidden: rec.name.startsWith("."),
    symlinkTarget: null,
    owner: null,
    group: null,
  };
}

export async function vfsHome(): Promise<string> {
  await openDb();
  return VIRTUAL_ROOT;
}

export async function vfsList(path: string): Promise<FileEntry[]> {
  const db = await openDb();
  const target = normalize(path);
  const store = tx(db, "readonly");
  const exists = await get(store, target);
  if (!exists) {
    return [];
  }
  const list = await listIndex(tx(db, "readonly"), target);
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  }).map(recordToEntry);
}

export async function vfsStat(path: string): Promise<FileEntry> {
  const db = await openDb();
  const target = normalize(path);
  const rec = await get(tx(db, "readonly"), target);
  if (!rec) throw new Error(`Not found: ${target}`);
  return recordToEntry(rec);
}

export async function vfsMkdir(path: string): Promise<void> {
  const db = await openDb();
  const target = normalize(path);
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  if (await get(store, target)) throw new Error(`Already exists: ${target}`);
  const parent = parentOf(target);
  if (parent && !(await get(store, parent))) {
    throw new Error(`Parent does not exist: ${parent}`);
  }
  await put(store, {
    path: target,
    parent,
    name: basenameOf(target),
    type: "dir",
    size: 0,
    mtime: Math.floor(Date.now() / 1000),
  });
}

export async function vfsRemove(path: string, recursive: boolean): Promise<void> {
  const db = await openDb();
  const target = normalize(path);
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const rec = await get(store, target);
  if (!rec) return;
  if (rec.type === "file") {
    await del(store, target);
    return;
  }
  const children = await listIndex(store, target);
  if (children.length > 0 && !recursive) {
    throw new Error(`Directory not empty: ${target}`);
  }
  for (const child of children) {
    await vfsRemove(child.path, true);
  }
  await del(db.transaction(STORE, "readwrite").objectStore(STORE), target);
}

export async function vfsRename(oldPath: string, newPath: string): Promise<void> {
  const db = await openDb();
  const oldT = normalize(oldPath);
  const newT = normalize(newPath);
  if (oldT === newT) return;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const rec = await get(store, oldT);
  if (!rec) throw new Error(`Not found: ${oldT}`);
  if (await get(store, newT)) throw new Error(`Destination exists: ${newT}`);
  if (rec.type === "file") {
    await put(store, {
      ...rec,
      path: newT,
      parent: parentOf(newT),
      name: basenameOf(newT),
      mtime: Math.floor(Date.now() / 1000),
    });
    await del(db.transaction(STORE, "readwrite").objectStore(STORE), oldT);
    return;
  }
  await put(store, {
    ...rec,
    path: newT,
    parent: parentOf(newT),
    name: basenameOf(newT),
    mtime: Math.floor(Date.now() / 1000),
  });
  const children = await listIndex(db.transaction(STORE, "readonly").objectStore(STORE), oldT);
  for (const child of children) {
    const childNew = newT + child.path.slice(oldT.length);
    await vfsRename(child.path, childNew);
  }
  await del(db.transaction(STORE, "readwrite").objectStore(STORE), oldT);
}

export async function vfsReadText(path: string): Promise<string> {
  const db = await openDb();
  const rec = await get(tx(db, "readonly"), normalize(path));
  if (!rec || rec.type !== "file" || !rec.data) throw new Error(`Not a file: ${path}`);
  return new TextDecoder().decode(rec.data);
}

export async function vfsReadBytes(path: string): Promise<ArrayBuffer> {
  const db = await openDb();
  const rec = await get(tx(db, "readonly"), normalize(path));
  if (!rec || rec.type !== "file" || !rec.data) throw new Error(`Not a file: ${path}`);
  return rec.data;
}

export async function vfsWriteBytes(
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const db = await openDb();
  const target = normalize(path);
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const parent = parentOf(target);
  if (parent && !(await get(store, parent))) {
    throw new Error(`Parent does not exist: ${parent}`);
  }
  await put(store, {
    path: target,
    parent,
    name: basenameOf(target),
    type: "file",
    size: data.byteLength,
    mtime: Math.floor(Date.now() / 1000),
    data,
  });
}

export async function vfsWriteText(path: string, text: string): Promise<void> {
  const buf = new TextEncoder().encode(text);
  await vfsWriteBytes(path, buf.buffer);
}

export function vfsDriveLabel(): string {
  return VIRTUAL_ROOT;
}

export function vfsExportToBrowser(filename: string, data: ArrayBuffer): void {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const VFS_ROOT = VIRTUAL_ROOT;

export type FileTypeAlias = FileType;
