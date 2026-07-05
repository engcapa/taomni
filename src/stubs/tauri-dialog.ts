// Browser-preview stub for @tauri-apps/plugin-dialog. Native dialogs do not
// exist in Vite preview, so path pickers use Taomni's in-app prompt.

import { promptAppDialog } from "../lib/appDialogs";
import { VFS_ROOT } from "./localVfs";

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
  canCreateDirectories?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  canCreateDirectories?: boolean;
}

export type OpenDialogReturn<T extends OpenDialogOptions | undefined = OpenDialogOptions | undefined> =
  T extends { multiple: true } ? string[] | null : string | null;

function defaultDialogPath(options?: { defaultPath?: string }): string {
  return options?.defaultPath?.trim() || VFS_ROOT;
}

export async function open<T extends OpenDialogOptions | undefined = OpenDialogOptions | undefined>(
  options?: T,
): Promise<OpenDialogReturn<T>> {
  const title = options?.title ?? (options?.directory ? "Folder path in browser VFS" : "File path in browser VFS");
  const selected = await promptAppDialog({
    title,
    initialValue: defaultDialogPath(options),
    allowEmpty: true,
  });
  const value = selected?.trim();
  if (!value) return null as OpenDialogReturn<T>;
  if (options?.multiple) {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean) as OpenDialogReturn<T>;
  }
  return value as OpenDialogReturn<T>;
}

export async function save(options?: SaveDialogOptions): Promise<string | null> {
  const selected = await promptAppDialog({
    title: options?.title ?? "Save path in browser VFS",
    initialValue: defaultDialogPath(options),
    allowEmpty: true,
  });
  return selected?.trim() || null;
}

export type MessageDialogResult = "Yes" | "No" | "Ok" | "Cancel" | (string & {});

export async function message(_message: string, _options?: unknown): Promise<MessageDialogResult> {
  return "Ok";
}

export async function ask(_message: string, _options?: unknown): Promise<boolean> {
  return false;
}

export async function confirm(_message: string, _options?: unknown): Promise<boolean> {
  return false;
}
