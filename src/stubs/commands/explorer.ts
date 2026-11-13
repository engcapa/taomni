import type {
  EntryOperationResult,
  LocalProperties,
  OperationFailure,
  PreviewBytes,
  PreviewText,
  TrashRef,
  TrashResult,
} from "../../lib/explorer";
import type { FileEntry } from "../../lib/sftp";
import {
  basenameOf,
  parentOf,
  vfsList,
  vfsMkdir,
  vfsReadBytes,
  vfsRemove,
  vfsRename,
  vfsStat,
  vfsWriteBytes,
  VFS_ROOT,
} from "../localVfs";
import { emit } from "../tauri-event";
import { readFiles, writeFiles } from "../fileClipboard";

interface Snapshot {
  entry: FileEntry;
  bytes?: ArrayBuffer;
  children: Snapshot[];
}

interface Operation {
  operationId?: string;
  bytes: number;
  items: number;
  lastProgress: number;
}

const trash = new Map<string, Snapshot>();
const cancelled = new Set<string>();
const TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
const PROPERTY_ITEM_LIMIT = 100_000;

function canonicalSpelling(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return "/" + parts.join("/");
}

function validName(name: string): void {
  if (!name || name === "." || name === ".." || /[\u0000-\u001f<>:"/\\|?*]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`Invalid file name: ${name}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await vfsStat(path);
    return true;
  } catch {
    return false;
  }
}

async function directory(path: string): Promise<string> {
  const normalized = canonicalSpelling(path || VFS_ROOT);
  const entry = await vfsStat(normalized);
  if (entry.fileType !== "dir") throw new Error(`Not a directory: ${path}`);
  return entry.path;
}

function failure(path: string, error: unknown, code = "io_error"): OperationFailure {
  return { path, code, message: error instanceof Error ? error.message : String(error) };
}

function checkCancelled(operation: Operation): void {
  if (operation.operationId && cancelled.has(operation.operationId)) {
    throw new Error("Operation cancelled; completed entries were retained");
  }
}

async function progress(operation: Operation, path: string, size: number): Promise<void> {
  operation.items++;
  operation.bytes += size;
  if (!operation.operationId || operation.items < 100 || Date.now() - operation.lastProgress < 100) return;
  operation.lastProgress = Date.now();
  await emit("explorer:progress", { operationId: operation.operationId, bytes: operation.bytes, items: operation.items, path });
}

async function conflictPath(destDir: string, entry: FileEntry): Promise<string> {
  const original = destDir + "/" + entry.name;
  if (!await exists(original)) return original;
  const dot = entry.fileType === "dir" ? -1 : entry.name.lastIndexOf(".");
  const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
  const extension = dot > 0 ? entry.name.slice(dot) : "";
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? " - 副本" : ` - 副本 (${number})`;
    const candidate = `${destDir}/${stem}${suffix}${extension}`;
    if (!await exists(candidate)) return candidate;
  }
}

async function copyTree(from: string, to: string, operation: Operation): Promise<void> {
  checkCancelled(operation);
  const entry = await vfsStat(from);
  if (await exists(to)) throw new Error(`Destination exists: ${to}`);
  if (entry.fileType === "dir") {
    await vfsMkdir(to);
    await progress(operation, from, 0);
    for (const child of await vfsList(from)) await copyTree(child.path, `${to}/${child.name}`, operation);
  } else {
    const bytes = await vfsReadBytes(from);
    checkCancelled(operation);
    await vfsWriteBytes(to, bytes.slice(0));
    await progress(operation, from, bytes.byteLength);
  }
}

async function transfer(sources: string[], destDir: string, move: boolean, operationId?: string): Promise<EntryOperationResult> {
  const result: EntryOperationResult = { done: [], failed: [] };
  const operation: Operation = { operationId, bytes: 0, items: 0, lastProgress: Date.now() };
  try {
    let destination: string;
    try {
      destination = await directory(destDir);
    } catch (error) {
      return { done: [], failed: sources.map((path) => failure(path, error)) };
    }
    for (const path of sources) {
      try {
        checkCancelled(operation);
        const entry = await vfsStat(canonicalSpelling(path));
        if (entry.fileType === "dir" && (destination === entry.path || destination.startsWith(entry.path + "/"))) {
          throw new Error("Cannot copy or move a directory into itself or its descendant");
        }
        if (move && parentOf(entry.path) === destination) {
          result.done.push({ from: path, to: entry.path });
          continue;
        }
        const target = await conflictPath(destination, entry);
        if (move) await vfsRename(entry.path, target);
        else await copyTree(entry.path, target, operation);
        result.done.push({ from: path, to: target });
      } catch (error) {
        result.failed.push(failure(path, error, operationId && cancelled.has(operationId) ? "cancelled" : "io_error"));
      }
    }
    return result;
  } finally {
    if (operationId) cancelled.delete(operationId);
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  const entry = await vfsStat(path);
  if (entry.fileType === "dir") {
    return { entry, children: await Promise.all((await vfsList(path)).map((child) => snapshot(child.path))) };
  }
  return { entry, bytes: await vfsReadBytes(path), children: [] };
}

async function restore(item: Snapshot): Promise<void> {
  if (item.entry.fileType === "dir") {
    await vfsMkdir(item.entry.path);
    for (const child of item.children) await restore(child);
  } else {
    await vfsWriteBytes(item.entry.path, item.bytes!.slice(0));
  }
}

async function trashEntries(paths: string[]): Promise<TrashResult> {
  // Explicit browser-only fault input; never pretends to prove a native failure.
  if (localStorage.getItem("taomni.explorer.stubTrashUnavailable") === "true") {
    return { trashed: [], failed: paths.map((path) => failure(path, "Browser fixture: system trash is unavailable", "trash_unavailable")) };
  }
  const result: TrashResult = { trashed: [], failed: [] };
  for (const path of paths) {
    try {
      const item = await snapshot(path);
      if (item.entry.path === VFS_ROOT) throw new Error("Cannot trash the filesystem root");
      await vfsRemove(path, true);
      const id = crypto.randomUUID();
      trash.set(id, item);
      result.trashed.push({ id, originalPath: item.entry.path });
    } catch (error) {
      result.failed.push(failure(path, error, "trash_unavailable"));
    }
  }
  return result;
}

async function restoreEntries(items: TrashRef[]): Promise<EntryOperationResult> {
  const result: EntryOperationResult = { done: [], failed: [] };
  for (const item of items) {
    try {
      const saved = trash.get(item.id);
      if (!saved || saved.entry.path !== item.originalPath) throw new Error("Trash entry is no longer available");
      if (await exists(item.originalPath)) throw new Error(`Destination exists: ${item.originalPath}`);
      await directory(parentOf(item.originalPath));
      await restore(saved);
      trash.delete(item.id);
      result.done.push({ from: item.originalPath, to: item.originalPath });
    } catch (error) {
      result.failed.push(failure(item.originalPath, error));
    }
  }
  return result;
}

async function properties(path: string, operationId?: string): Promise<LocalProperties> {
  const entry = await vfsStat(path);
  const result: LocalProperties = {
    path: entry.path, name: entry.name, fileType: entry.fileType,
    size: entry.fileType === "dir" ? 0 : entry.size,
    itemCount: 0, truncated: false, mtime: entry.mtime, createdAt: null,
    mode: entry.mode, owner: entry.owner ?? null, group: entry.group ?? null,
    symlinkTarget: entry.symlinkTarget ?? null,
  };
  const operation: Operation = { operationId, bytes: 0, items: 0, lastProgress: Date.now() };
  async function walk(directoryPath: string): Promise<void> {
    for (const child of await vfsList(directoryPath)) {
      checkCancelled(operation);
      if (result.itemCount >= PROPERTY_ITEM_LIMIT) {
        result.truncated = true;
        return;
      }
      result.itemCount++;
      if (child.fileType === "dir") await walk(child.path);
      else result.size += child.size;
      if (result.truncated) return;
    }
  }
  try {
    if (entry.fileType === "dir") await walk(entry.path);
    return result;
  } finally {
    if (operationId) cancelled.delete(operationId);
  }
}

async function readText(path: string): Promise<PreviewText> {
  const delay = Number(localStorage.getItem("taomni.explorer.stubTextDelayMs"));
  if (delay > 0 && delay <= 2000) await new Promise((resolve) => setTimeout(resolve, delay));
  const bytes = new Uint8Array(await vfsReadBytes(path));
  const prefix = bytes.subarray(0, TEXT_LIMIT);
  const binary = prefix.includes(0);
  return { text: binary ? "" : new TextDecoder().decode(prefix, { stream: bytes.length > TEXT_LIMIT }), truncated: bytes.length > TEXT_LIMIT, binary };
}

async function readImage(path: string, maxBytes = IMAGE_LIMIT): Promise<PreviewBytes> {
  const entry = await vfsStat(path);
  if (entry.size > Math.min(maxBytes, IMAGE_LIMIT)) throw new Error("too_large: image preview limit is 20 MB");
  const bytes = new Uint8Array(await vfsReadBytes(path));
  if (bytes.length > Math.min(maxBytes, IMAGE_LIMIT)) throw new Error("too_large: image preview limit is 20 MB");
  const extension = basenameOf(path).split(".").pop()?.toLowerCase() ?? "";
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" } as Record<string, string>)[extension] ?? "application/octet-stream";
  return { bytes: Array.from(bytes), mime };
}

export async function invokeExplorer<T>(command: string, args: Record<string, any> = {}): Promise<T> {
  switch (command) {
    case "explorer_canonical_path":
      return (await vfsStat(canonicalSpelling(String(args.path)))).path as T;
    case "explorer_same_volume":
      await vfsStat(args.source);
      await directory(args.destDir);
      return true as T;
    case "explorer_write_clipboard_files":
      writeFiles(args.paths);
      return undefined as T;
    case "explorer_update_cut_clipboard": {
      const current = readFiles();
      if (current.length !== args.expectedPaths.length || current.some((path, index) => path !== args.expectedPaths[index])) return false as T;
      writeFiles(args.remainingPaths);
      return true as T;
    }
    case "local_copy_entries":
    case "local_move_entries":
      return await transfer(args.sources, args.destDir, command === "local_move_entries", args.operationId) as T;
    case "local_trash_entries":
      return await trashEntries(args.paths) as T;
    case "local_trash_restore":
      return await restoreEntries(args.items) as T;
    case "local_properties":
      return await properties(args.path, args.operationId) as T;
    case "explorer_read_preview_text":
      return await readText(args.path) as T;
    case "explorer_read_preview_bytes":
      return await readImage(args.path, args.maxBytes) as T;
    case "explorer_cancel_operation":
      cancelled.add(args.operationId);
      return undefined as T;
    case "local_rename_entry": {
      validName(args.name);
      const path = `${parentOf(args.path)}/${args.name}`;
      await vfsRename(args.path, path);
      return path as T;
    }
    case "local_create_entry": {
      validName(args.name);
      const parent = await directory(args.destDir);
      const dot = args.directory ? -1 : args.name.lastIndexOf(".");
      const stem = dot > 0 ? args.name.slice(0, dot) : args.name;
      const extension = dot > 0 ? args.name.slice(dot) : "";
      let path = `${parent}/${args.name}`;
      for (let number = 2; await exists(path); number++) path = `${parent}/${stem} (${number})${extension}`;
      if (args.directory) await vfsMkdir(path);
      else await vfsWriteBytes(path, new ArrayBuffer(0));
      return path as T;
    }
    default:
      throw new Error(`Unknown Explorer command: ${command}`);
  }
}
