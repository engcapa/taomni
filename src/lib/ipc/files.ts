import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog, type OpenDialogOptions, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";

export function optionalDialogPath(path?: string | null): string | undefined {
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

export function firstDialogPath(selected: string | string[] | null): string | null {
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) {
    return selected.find((item) => typeof item === "string" && item.trim()) ?? null;
  }
  return null;
}

export function saveDialogDefaultPath(defaultName?: string, currentPath?: string): string | undefined {
  const name = optionalDialogPath(defaultName);
  const current = optionalDialogPath(currentPath);
  if (!name) return current;
  if (!current) return name;
  if (/[\\/]$/.test(current)) return `${current}${name}`;

  const slash = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
  if (slash >= 0) return `${current.slice(0, slash + 1)}${name}`;
  return name;
}

export async function selectOnePath(options: OpenDialogOptions): Promise<string | null> {
  return firstDialogPath(await openDialog({ multiple: false, ...options }));
}

export async function selectPrivateKeyFile(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select private key",
    directory: false,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function selectUploadFile(): Promise<string[]> {
  const selected = await openDialog({
    title: "Select files to send",
    multiple: true,
    directory: false,
  });
  return selected?.filter((item) => item.trim()) ?? [];
}

export async function selectSaveDirectory(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select save directory",
    directory: true,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function selectSaveFilePath(
  defaultName?: string,
  currentPath?: string,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: "Save as",
    defaultPath: saveDialogDefaultPath(defaultName, currentPath),
  };
  return saveDialog(options);
}

export async function selectFilePath(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select file to open",
    directory: false,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function getHomeDir(): Promise<string | null> {
  return invoke<string | null>("get_home_dir", {});
}

export async function selectFolderPath(currentPath?: string): Promise<string | null> {
  return selectOnePath({
    title: "Select folder to open",
    directory: true,
    defaultPath: optionalDialogPath(currentPath),
  });
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}

export interface ReadStreamOpenResult {
  handleId: string;
  size: number;
  mtime: number;
}

export async function readStreamOpen(path: string): Promise<ReadStreamOpenResult> {
  return invoke<ReadStreamOpenResult>("read_stream_open", { path });
}

export async function readStreamRead(handleId: string, maxBytes = 64 * 1024): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_stream_read", { handleId, maxBytes });
  return new Uint8Array(buffer);
}

export async function readStreamClose(handleId: string): Promise<void> {
  return invoke("read_stream_close", { handleId });
}

export async function writeStreamOpen(path: string): Promise<string> {
  return invoke<string>("write_stream_open", { path });
}

export async function writeStreamAppend(handleId: string, data: Uint8Array): Promise<void> {
  return invoke("write_stream_append", data, {
    headers: { "x-handle-id": handleId },
  });
}

export async function writeStreamClose(handleId: string): Promise<void> {
  return invoke("write_stream_close", { handleId });
}

export async function writeStreamAbort(handleId: string): Promise<void> {
  return invoke("write_stream_abort", { handleId });
}

export async function checkFileExists(path: string): Promise<boolean> {
  return invoke<boolean>("check_file_exists", { path });
}

export async function temporaryFilePath(defaultName: string): Promise<string> {
  return invoke<string>("temporary_file_path", { defaultName });
}

export async function openLocalPath(path: string): Promise<void> {
  return invoke("sftp_open_path", { path });
}
