import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo } from "../../../../types";
import type { OpenFileEol } from "../editorGroupTypes";
import { type DirectoryState, type FlatFilesState, type LibraryBufferInfo, type OpenFileState } from "./types";
import { looseIdForPath, pathName, fileKey, rootIdForPath, joinRelativePath, parentPath, basename } from "./paths";
import { hashString } from "./identity";

export const DEFAULT_DIR_STATE: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
};

export const DEFAULT_FLAT_FILES_STATE: FlatFilesState = {
  entries: [],
  loading: false,
  loaded: false,
  error: null,
  truncated: false,
};

export const LIBRARY_LANGUAGE_EXTENSIONS: Record<string, string> = {
  java: "java",
  kotlin: "kt",
  scala: "scala",
  groovy: "groovy",
  csharp: "cs",
  swift: "swift",
  cpp: "cpp",
  c: "c",
  python: "py",
  rust: "rs",
  go: "go",
  typescript: "ts",
  typescriptreact: "tsx",
  javascript: "js",
  javascriptreact: "jsx",
};

/**
 * True when a location "path" is really a document URI (`jdt://`, `jar:file:`,
 * `file://`, …) rather than a filesystem path. Language servers and our own
 * symbol mapping both fall back to the URI when there is no path, and reading
 * such a string from disk always fails.
 */
export function looksLikeDocumentUri(candidate: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(candidate.trim());
  if (!match) return false;
  // A single letter before the colon is a Windows drive (C:\src\Main.java).
  return match[1]!.length > 1;
}

/** Library buffers are keyed by URI so same-named classes never collide. */
export function libraryFileRef(uri: string): CodeWorkspaceFileRef {
  return { kind: "loose", id: looseIdForPath(uri), path: uri };
}

/** File name used only for syntax highlighting of a library buffer. */
export function libraryLanguagePath(info: LibraryBufferInfo): string {
  const title = info.title.trim();
  if (title.includes(".")) return title;
  const extension = LIBRARY_LANGUAGE_EXTENSIONS[info.languageId] ?? "txt";
  return `${title || "Library"}.${extension}`;
}

/** Read-only open-buffer view model for a library source (never touches disk). */
export function makeLibraryFile(info: LibraryBufferInfo, text: string): OpenFileState {
  const ref = libraryFileRef(info.uri);
  const normalized = normalizeEditorText(text);
  const title = info.title.trim() || pathName(info.uri, "Library");
  return {
    ref,
    key: fileKey(ref),
    path: info.uri,
    title,
    subtitle: info.container ? `${info.container} · ${title}` : title,
    languagePath: libraryLanguagePath(info),
    text: normalized.text,
    savedText: normalized.text,
    eol: normalized.eol,
    encoding: "UTF-8",
    bom: false,
    hash: `library:${hashString(info.uri)}`,
    mtime: 0,
    size: normalized.text.length,
    loading: false,
    saving: false,
    dirty: false,
    documentRevision: 0,
    error: null,
    library: {
      uri: info.uri,
      container: info.container,
      originFilePath: info.originFilePath,
      originRootPath: info.originRootPath,
      decompiled: info.decompiled ?? false,
    },
  };
}

export function makeRoot(path: string, kind: CodeWorkspaceRootInfo["kind"] = "folder"): CodeWorkspaceRootInfo {
  const normalized = path.trim();
  return {
    id: rootIdForPath(normalized),
    name: pathName(normalized),
    path: normalized,
    kind,
  };
}

export function makeLooseFile(path: string): CodeWorkspaceLooseFileInfo {
  const normalized = path.trim();
  return {
    id: looseIdForPath(normalized),
    name: pathName(normalized, "File"),
    path: normalized,
  };
}

export function initialRoots(workspace: CodeWorkspaceTabInfo): CodeWorkspaceRootInfo[] {
  if (workspace.roots?.length) return workspace.roots;
  const legacy = workspace.repoRoot.trim();
  return legacy ? [makeRoot(legacy, "git")] : [];
}

export function initialLooseFiles(workspace: CodeWorkspaceTabInfo): CodeWorkspaceLooseFileInfo[] {
  return workspace.looseFiles ?? [];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMtime(mtime: number): string {
  if (!mtime) return "";
  try {
    return new Date(mtime * 1000).toLocaleString();
  } catch {
    return "";
  }
}

/**
 * CodeMirror always stores LF line endings. Normalize disk text to LF for the
 * buffer and remember the original style so save can restore it.
 */
export function normalizeEditorText(text: string): { text: string; eol: OpenFileEol; } {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let eol: OpenFileEol = "LF";
  if (source.includes("\r\n")) eol = "CRLF";
  else if (source.includes("\r")) eol = "CR";
  return {
    text: source.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    eol,
  };
}

/** Convert LF buffer text back to the file's original line endings on save. */
export function applyEditorEol(text: string, eol: OpenFileEol): string {
  if (eol === "CRLF") return text.replace(/\n/g, "\r\n");
  if (eol === "CR") return text.replace(/\n/g, "\r");
  return text;
}

export function isRootRef(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && ref.path === path;
}

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#");
}

export function normalizeRelativeLink(path: string): string {
  const clean = path.split("#", 1)[0].split("?", 1)[0].replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function resolveRootMarkdownLink(currentPath: string, href: string): string {
  return normalizeRelativeLink(joinRelativePath(parentPath(currentPath), href));
}

export function resolveLooseMarkdownLink(currentPath: string, href: string): string {
  const normalized = currentPath.replace(/\\/g, "/");
  return joinRelativePath(parentPath(normalized), href);
}

export function makeLoadingFile(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): OpenFileState {
  const meta = fileMeta(ref, roots, looseFiles);
  return {
    ref,
    key: fileKey(ref),
    path: meta.path,
    title: meta.title,
    subtitle: meta.subtitle,
    languagePath: meta.languagePath,
    text: "",
    savedText: "",
    eol: "LF",
    encoding: "UTF-8",
    bom: false,
    hash: "",
    mtime: 0,
    size: 0,
    loading: true,
    saving: false,
    dirty: false,
    documentRevision: 0,
    error: null,
  };
}

export function fileMeta(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]) {
  if (ref.kind === "root") {
    const root = roots.find((item) => item.id === ref.rootId);
    const title = basename(ref.path);
    return {
      title,
      path: ref.path,
      subtitle: root ? `${root.name} / ${ref.path}` : ref.path,
      languagePath: ref.path,
    };
  }
  const loose = looseFiles.find((item) => item.id === ref.id);
  const title = loose?.name || pathName(ref.path, "File");
  return {
    title,
    path: ref.path,
    subtitle: ref.path,
    languagePath: ref.path,
  };
}

export function workspaceTitle(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): string {
  if (workspace.name?.trim()) return workspace.name.trim();
  if (roots.length === 1 && looseFiles.length === 0) return roots[0].name;
  if (roots.length === 0 && looseFiles.length > 0) return "Editor Workspace";
  return "Code Workspace";
}

export function initialFileRef(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): CodeWorkspaceFileRef | null {
  if (workspace.initialFile) return workspace.initialFile;
  const initialPath = workspace.initialPath?.trim();
  if (initialPath && roots[0]) {
    return { kind: "root", rootId: roots[0].id, path: initialPath };
  }
  return looseFiles[0] ? { kind: "loose", id: looseFiles[0].id, path: looseFiles[0].path } : null;
}

export { hashString } from "./identity";
