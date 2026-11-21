import { invoke } from "@tauri-apps/api/core";

export interface NotepadSaveAsResult {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface NotepadRenameResult {
  oldPath: string;
  newPath: string;
  name: string;
}

export interface NotepadBackupEntry {
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
}

export interface NotepadBackupContent {
  entry: NotepadBackupEntry;
  content: string;
}

export interface NotepadEncodingGroup {
  group: string;
  encodings: string[];
}

export interface NotepadEncodingLossReport {
  encoding: string;
  unrepresentableCount: number;
  samples: string[];
}

export interface NotepadHashResult {
  algorithm: string;
  hex: string;
}

export interface NotepadMacroLoadResult {
  json: string;
  expectedHash: string;
  actualHash: string;
  tampered: boolean;
}

export interface NotepadDirFilesResult {
  files: string[];
  totalCandidates: number;
  skippedBinary: number;
  truncated: boolean;
}

export function viewerSaveAs(args: {
  path: string;
  content: string;
  encoding: string;
  bom: boolean;
  eol: string;
  overwrite: boolean;
}): Promise<NotepadSaveAsResult> {
  return invoke<NotepadSaveAsResult>("viewer_save_as", args);
}

export function viewerRename(oldPath: string, newName: string): Promise<NotepadRenameResult> {
  return invoke<NotepadRenameResult>("viewer_rename", { oldPath, newName });
}

export function viewerTrash(path: string): Promise<string> {
  return invoke<string>("viewer_trash", { path });
}

export function viewerSetReadonlyAttr(path: string, readonly: boolean): Promise<boolean> {
  return invoke<boolean>("viewer_set_readonly_attr", { path, readonly });
}

export function viewerWriteTextElevated(args: {
  path: string;
  content: string;
  encoding: string;
  bom: boolean;
  eol: string;
}): Promise<NotepadSaveAsResult> {
  return invoke<NotepadSaveAsResult>("viewer_write_text_elevated", args);
}

export function notepadOpenTerminalDir(
  path: string,
  preferredShell?: string,
): Promise<void> {
  return invoke<void>("notepad_open_terminal_dir", {
    path,
    preferredShell: preferredShell ?? null,
  });
}

export function notepadListDirTextFiles(
  path: string,
  maxCount?: number,
): Promise<NotepadDirFilesResult> {
  return invoke<NotepadDirFilesResult>("notepad_list_dir_text_files", {
    path,
    maxCount: maxCount ?? null,
  });
}

export function notepadBackupWrite(args: {
  docId: string;
  path: string | null;
  name: string;
  content: string;
  encoding: string;
  bom: boolean;
  eol: string;
  savedHash: string;
}): Promise<NotepadBackupEntry> {
  return invoke<NotepadBackupEntry>("notepad_backup_write", args);
}

export function notepadBackupList(): Promise<NotepadBackupEntry[]> {
  return invoke<NotepadBackupEntry[]>("notepad_backup_list");
}

export function notepadBackupRead(id: string): Promise<NotepadBackupContent> {
  return invoke<NotepadBackupContent>("notepad_backup_read", { id });
}

export function notepadBackupPrune(docId: string): Promise<void> {
  return invoke<void>("notepad_backup_prune", { docId });
}

export function notepadSaveBackupCopy(args: {
  sourcePath: string;
  mode: string;
  customDir?: string | null;
}): Promise<string | null> {
  return invoke<string | null>("notepad_save_backup_copy", {
    sourcePath: args.sourcePath,
    mode: args.mode,
    customDir: args.customDir ?? null,
  });
}

export function notepadHash(args: {
  algorithm: "md5" | "sha1" | "sha256" | "sha512";
  text?: string;
  filePath?: string;
}): Promise<NotepadHashResult> {
  return invoke<NotepadHashResult>("notepad_hash", {
    algorithm: args.algorithm,
    text: args.text ?? null,
    filePath: args.filePath ?? null,
  });
}

export function notepadListEncodings(): Promise<NotepadEncodingGroup[]> {
  return invoke<NotepadEncodingGroup[]>("notepad_list_encodings");
}

export function notepadCheckEncodingLoss(
  content: string,
  encodingLabel: string,
): Promise<NotepadEncodingLossReport> {
  return invoke<NotepadEncodingLossReport>("notepad_check_encoding_loss", {
    content,
    encodingLabel,
  });
}

export function notepadMacrosLoad(): Promise<NotepadMacroLoadResult> {
  return invoke<NotepadMacroLoadResult>("notepad_macros_load");
}

export function notepadMacrosSave(json: string): Promise<NotepadMacroLoadResult> {
  return invoke<NotepadMacroLoadResult>("notepad_macros_save", { json });
}

export function notepadMacrosValidate(): Promise<NotepadMacroLoadResult> {
  return invoke<NotepadMacroLoadResult>("notepad_macros_validate");
}

export function notepadMacrosAccept(): Promise<NotepadMacroLoadResult> {
  return invoke<NotepadMacroLoadResult>("notepad_macros_accept");
}

export function notepadSessionSave(json: string, filePath?: string | null): Promise<string> {
  return invoke<string>("notepad_session_save", {
    filePath: filePath ?? null,
    json,
  });
}

export function notepadSessionLoad(filePath?: string | null): Promise<string | null> {
  return invoke<string | null>("notepad_session_load", {
    filePath: filePath ?? null,
  });
}
