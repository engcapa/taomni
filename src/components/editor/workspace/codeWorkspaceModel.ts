/**
 * Pure types and helpers for Code Workspace (no React).
 * Extracted from CodeWorkspaceTab to shrink the shell and share with store/UI units.
 */
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo, CodeWorkspaceTabInfo } from "../../../types";
import type { WorkspaceEntry, WorkspaceGitRoot } from "../../../lib/editor/workspace";
import type { LspCustomServerCommand, LspDocumentStatus, LspDiagnostic } from "../../../lib/editor/lsp";
import type { GitChange } from "../../../lib/git";
import { DEFAULT_CODE_VIEW_PROFILE } from "../../../lib/codeViewProfile";
import type { LspCustomCommandConfig } from "./FileTreePane";
import type { OpenFileViewModel } from "./editorGroupTypes";
import type { FileTreeViewMode } from "./FileTreePane";

export type MermaidApi = typeof import("mermaid").default;

export type OpenFileState = OpenFileViewModel;
export type TreeViewMode = FileTreeViewMode;
export type MarkdownViewMode = "edit" | "preview" | "split";
export interface DirectoryState {
  entries: WorkspaceEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface CompactChainState {
  path: string;
  entries: WorkspaceEntry[];
  loading: boolean;
  error: string | null;
}

export interface LspFileState {
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
  syncing: boolean;
  syncedText: string | null;
  error: string | null;
}

export type TreeSelection =
  | { kind: "root"; rootId: string }
  | { kind: "dir"; rootId: string; path: string }
  | { kind: "file"; ref: CodeWorkspaceFileRef };
export interface WorkspaceTreeCommandPayload {
  selection?: TreeSelection;
  directory?: { rootId: string; path: string };
  rootId?: string;
  path?: string;
}


export const LSP_COMMAND_PREFS_KEY = "taomni.codeWorkspace.lspCommandPrefs.v1";
export const LSP_CUSTOM_COMMANDS_KEY = "taomni.codeWorkspace.lspCustomCommands.v1";
export const CUSTOM_LSP_COMMAND_ID = "__custom__";
export const TREE_FONT_SIZE_KEY = "taomni.codeWorkspace.treeFontSize.v1";
export const TREE_VIEW_MODE_KEY = "taomni.codeWorkspace.treeViewMode.v1";
export const FLAT_VIEW_MAX_FILES = 2_000;
export const FLAT_VIEW_MAX_DEPTH = 25;
export const NAV_HISTORY_LIMIT = 100;
export const RECENT_FILES_LIMIT = 50;
export const CODE_WORKSPACE_MIN_FONT_SIZE = 8;
export const CODE_WORKSPACE_MAX_FONT_SIZE = 32;
export const CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE = 12;
export const CODE_WORKSPACE_MIN_TREE_FONT_SIZE = 10;
export const CODE_WORKSPACE_MAX_TREE_FONT_SIZE = 20;

export let mermaidReady = false;
export let mermaidPromise: Promise<MermaidApi> | null = null;

export const DEFAULT_DIR_STATE: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
};

export interface FlatFilesState {
  entries: WorkspaceEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  truncated: boolean;
}

export const DEFAULT_FLAT_FILES_STATE: FlatFilesState = {
  entries: [],
  loading: false,
  loaded: false,
  error: null,
  truncated: false,
};

export interface WorkspaceGitSnapshotState {
  changes: GitChange[];
  headOid: string | null;
  currentBranch: string | null;
  loading: boolean;
  error: string | null;
}


export function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid")
    .then((mod) => mod.default)
    .catch((err) => {
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

export async function ensureMermaidReady(): Promise<MermaidApi> {
  const mermaid = await loadMermaid();
  if (mermaidReady) return mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
  });
  mermaidReady = true;
  return mermaid;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMermaidSvg(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  downloadBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), fileName);
}

export function exportMermaidPng(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.onload = () => {
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(box?.width || rect.width || image.width || 960));
    const height = Math.max(1, Math.ceil(box?.height || rect.height || image.height || 540));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(url);
      if (blob) downloadBlob(blob, fileName);
    }, "image/png");
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}

export function pathName(path: string, fallback = "Workspace"): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || fallback;
}

export function rootIdForPath(path: string): string {
  return `root-${hashString(path)}`;
}

export function looseIdForPath(path: string): string {
  return `loose-${hashString(path)}`;
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

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function joinRelativePath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

export function remapRelativePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path;
}

export function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function relativePathWithinRoot(rootPath: string, filePath: string): string | null {
  const root = normalizeFsPath(rootPath);
  const file = normalizeFsPath(filePath);
  if (file === root) return "";
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
}

export function absoluteWorkspacePath(root: CodeWorkspaceRootInfo, workspacePath: string): string {
  const rootPath = normalizeFsPath(root.path);
  const cleanPath = normalizeFsPath(workspacePath).replace(/^\/+/, "");
  return cleanPath ? `${rootPath}/${cleanPath}` : rootPath;
}

export function gitPathForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  workspacePath: string,
): string | null {
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const filePath = absoluteWorkspacePath(root, workspacePath);
  if (filePath === repoRoot) return "";
  return filePath.startsWith(`${repoRoot}/`) ? filePath.slice(repoRoot.length + 1) : null;
}

export function workspacePathForGitPath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  gitPath: string,
): string | null {
  const rootPath = normalizeFsPath(root.path);
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const cleanPath = normalizeFsPath(gitPath).replace(/^\/+/, "");
  const filePath = cleanPath ? `${repoRoot}/${cleanPath}` : repoRoot;
  if (filePath === rootPath) return "";
  return filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : null;
}

export function gitRootsForWorkspaceRoot(root: CodeWorkspaceRootInfo, gitRoots: WorkspaceGitRoot[]): WorkspaceGitRoot[] {
  return gitRoots
    .filter((repo) => repo.rootIds.includes(root.id))
    .sort((a, b) => normalizeFsPath(b.repoRoot).length - normalizeFsPath(a.repoRoot).length);
}

export function gitRootForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  workspacePath: string,
  gitRoots: WorkspaceGitRoot[],
): WorkspaceGitRoot | null {
  for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
    if (gitPathForWorkspacePath(root, repo, workspacePath) !== null) return repo;
  }
  return null;
}

export function rootDirKey(rootId: string, path = ""): string {
  return `${rootId}:${path}`;
}

export function fileKey(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root" ? `root:${ref.rootId}:${ref.path}` : `loose:${ref.id}`;
}

export function fileRefEquals(a: CodeWorkspaceFileRef, b: CodeWorkspaceFileRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "root"
    ? b.kind === "root" && a.rootId === b.rootId && a.path === b.path
    : b.kind === "loose" && a.id === b.id && a.path === b.path;
}

export function fileRefUnder(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && (ref.path === path || ref.path.startsWith(`${path}/`));
}

export function remapFileRef(ref: CodeWorkspaceFileRef, rootId: string, fromPath: string, toPath: string): CodeWorkspaceFileRef {
  if (ref.kind !== "root" || ref.rootId !== rootId) return ref;
  return { ...ref, path: remapRelativePath(ref.path, fromPath, toPath) };
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

export function shouldHideEntry(entry: WorkspaceEntry): boolean {
  return entry.path === ".git" || entry.path.startsWith(".git/");
}

/** Compact-tree display name: `src` → `src/main` when a single-child chain is folded. */
export function compactEntryName(
  entry: WorkspaceEntry,
  chain: { path: string } | undefined,
): string {
  if (!chain || chain.path === entry.path) return entry.name;
  const suffix = chain.path.startsWith(`${entry.path}/`)
    ? chain.path.slice(entry.path.length + 1)
    : "";
  return suffix ? `${entry.name}/${suffix}` : entry.name;
}

/** Flat-view group key by file extension (lowercase, including the dot). */
export function flatExtensionGroup(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "No extension";
  return name.slice(dot).toLowerCase();
}

/** Lookup a git change in the precomputed `rootId:workspacePath` map. */
export function gitChangeForPath(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): GitChange | undefined {
  return gitChangeByRootPath.get(`${rootId}:${path}`);
}

/** Count git changes under a directory (or whole root when path is empty). */
export function gitDirectoryChangeCount(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): number {
  const prefix = path ? `${rootId}:${path}/` : `${rootId}:`;
  let count = 0;
  for (const key of gitChangeByRootPath.keys()) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

export function isRootRef(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && ref.path === path;
}

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function lspPresetIdForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) return "typescript-javascript";
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(py|pyi)$/.test(lower)) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/.test(lower)) return "cpp";
  if (/\.(kt|kts)$/.test(lower)) return "kotlin";
  if (/\.(scala|sc)$/.test(lower)) return "scala";
  if (/\.(cs|csx)$/.test(lower)) return "csharp";
  if (lower.endsWith(".swift")) return "swift";
  return null;
}

export function readLspCommandPrefs(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_COMMAND_PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLspCommandPrefs(prefs: Record<string, string>): void {
  try {
    window.localStorage.setItem(LSP_COMMAND_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
}

export function readLspCustomCommands(): Record<string, LspCustomCommandConfig> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_CUSTOM_COMMANDS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LspCustomCommandConfig> = {};
    for (const [presetId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const command = typeof (value as { command?: unknown }).command === "string"
        ? (value as { command: string }).command
        : "";
      const args = typeof (value as { args?: unknown }).args === "string"
        ? (value as { args: string }).args
        : "";
      if (command.trim() || args.trim()) out[presetId] = { command, args };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLspCustomCommands(commands: Record<string, LspCustomCommandConfig>): void {
  try {
    window.localStorage.setItem(LSP_CUSTOM_COMMANDS_KEY, JSON.stringify(commands));
  } catch {
    // Ignore storage failures.
  }
}

export function splitCommandArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

export function customServerCommandFromConfig(config?: LspCustomCommandConfig): LspCustomServerCommand | null {
  const command = config?.command.trim() ?? "";
  if (!command) return null;
  return {
    label: "Custom",
    command,
    args: splitCommandArgs(config?.args ?? ""),
  };
}

export function clampCodeWorkspaceFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CODE_VIEW_PROFILE.fontSize;
  return Math.min(CODE_WORKSPACE_MAX_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_FONT_SIZE, Math.round(size)));
}

export function clampCodeWorkspaceTreeFontSize(size: number): number {
  if (!Number.isFinite(size)) return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  return Math.min(CODE_WORKSPACE_MAX_TREE_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_TREE_FONT_SIZE, Math.round(size)));
}

export function readCodeWorkspaceTreeFontSize(): number {
  try {
    const raw = window.localStorage.getItem(TREE_FONT_SIZE_KEY);
    return raw ? clampCodeWorkspaceTreeFontSize(Number(raw)) : CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  } catch {
    return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  }
}

export function writeCodeWorkspaceTreeFontSize(size: number): void {
  try {
    window.localStorage.setItem(TREE_FONT_SIZE_KEY, String(clampCodeWorkspaceTreeFontSize(size)));
  } catch {
    // Ignore storage failures.
  }
}

export function readCodeWorkspaceTreeViewMode(): TreeViewMode {
  try {
    const raw = window.localStorage.getItem(TREE_VIEW_MODE_KEY);
    return raw === "compact" || raw === "flat" || raw === "tree" ? raw : "tree";
  } catch {
    return "tree";
  }
}

export function writeCodeWorkspaceTreeViewMode(mode: TreeViewMode): void {
  try {
    window.localStorage.setItem(TREE_VIEW_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

export function emptyLspFileState(): LspFileState {
  return {
    status: null,
    diagnostics: [],
    syncing: false,
    syncedText: null,
    error: null,
  };
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
    hash: "",
    mtime: 0,
    size: 0,
    loading: true,
    saving: false,
    dirty: false,
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
