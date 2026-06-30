import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { EditorState, Compartment, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Tooltip,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  ListTree,
  Columns2,
  Eye,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  workspaceCreateDir,
  workspaceCreateFile,
  workspaceDeletePath,
  workspaceListDir,
  workspaceReadFile,
  workspaceReadLooseFile,
  workspaceRenamePath,
  workspaceWriteFile,
  workspaceWriteLooseFile,
  type WorkspaceEntry,
} from "../../lib/editor/workspace";
import {
  lspChangeDocument,
  lspCloseDocument,
  lspDetectServers,
  lspGetDiagnostics,
  lspDefinition,
  lspHover,
  lspOpenDocument,
  lspReferences,
  lspSaveDocument,
  type LspCustomServerCommand,
  type LspDiagnostic,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspLocation,
  type LspPosition,
  type LspServerStatus,
} from "../../lib/editor/lsp";
import { selectFilePath, selectFolderPath } from "../../lib/ipc";
import { codeViewExtensions } from "../../lib/codeViewTheme";
import { renderFormatted } from "../../lib/chat/renderFormatted";
import { useAppStore } from "../../stores/appStore";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { languageForPath } from "../git/diffLanguage";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
  CodeWorkspaceTabInfo,
} from "../../types";

interface CodeWorkspaceTabProps {
  tabId: string;
  workspace: CodeWorkspaceTabInfo;
  visible?: boolean;
}

interface DirectoryState {
  entries: WorkspaceEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

interface OpenFileState {
  ref: CodeWorkspaceFileRef;
  key: string;
  path: string;
  title: string;
  subtitle: string;
  languagePath: string;
  text: string;
  savedText: string;
  hash: string;
  mtime: number;
  size: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

interface LspFileState {
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
  syncing: boolean;
  syncedText: string | null;
  error: string | null;
}

interface EditorRevealTarget {
  key: string;
  line: number;
  character: number;
  nonce: number;
}

interface ReferencesResultState {
  loading: boolean;
  origin: string | null;
  locations: LspLocation[];
  error: string | null;
}

type TreeSelection =
  | { kind: "root"; rootId: string }
  | { kind: "dir"; rootId: string; path: string }
  | { kind: "file"; ref: CodeWorkspaceFileRef };

type MarkdownViewMode = "edit" | "preview" | "split";

const LSP_COMMAND_PREFS_KEY = "taomni.codeWorkspace.lspCommandPrefs.v1";
const LSP_CUSTOM_COMMANDS_KEY = "taomni.codeWorkspace.lspCustomCommands.v1";
const CUSTOM_LSP_COMMAND_ID = "__custom__";
let mermaidReady = false;

interface LspCustomCommandConfig {
  command: string;
  args: string;
}

const DEFAULT_DIR_STATE: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
};

const WORKSPACE_EDITOR_STYLE = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-foldGutter .cm-gutterElement": {
    minWidth: "1.6ch",
    padding: "0 4px",
  },
});

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function ensureMermaidReady(): void {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
  });
  mermaidReady = true;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMermaidSvg(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  downloadBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), fileName);
}

function exportMermaidPng(svg: SVGSVGElement, fileName: string): void {
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

function pathName(path: string, fallback = "Workspace"): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || fallback;
}

function rootIdForPath(path: string): string {
  return `root-${hashString(path)}`;
}

function looseIdForPath(path: string): string {
  return `loose-${hashString(path)}`;
}

function makeRoot(path: string, kind: CodeWorkspaceRootInfo["kind"] = "folder"): CodeWorkspaceRootInfo {
  const normalized = path.trim();
  return {
    id: rootIdForPath(normalized),
    name: pathName(normalized),
    path: normalized,
    kind,
  };
}

function makeLooseFile(path: string): CodeWorkspaceLooseFileInfo {
  const normalized = path.trim();
  return {
    id: looseIdForPath(normalized),
    name: pathName(normalized, "File"),
    path: normalized,
  };
}

function initialRoots(workspace: CodeWorkspaceTabInfo): CodeWorkspaceRootInfo[] {
  if (workspace.roots?.length) return workspace.roots;
  const legacy = workspace.repoRoot.trim();
  return legacy ? [makeRoot(legacy, "git")] : [];
}

function initialLooseFiles(workspace: CodeWorkspaceTabInfo): CodeWorkspaceLooseFileInfo[] {
  return workspace.looseFiles ?? [];
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function joinRelativePath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

function remapRelativePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path;
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativePathWithinRoot(rootPath: string, filePath: string): string | null {
  const root = normalizeFsPath(rootPath);
  const file = normalizeFsPath(filePath);
  if (file === root) return "";
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
}

function rootDirKey(rootId: string, path = ""): string {
  return `${rootId}:${path}`;
}

function fileKey(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root" ? `root:${ref.rootId}:${ref.path}` : `loose:${ref.id}`;
}

function fileRefEquals(a: CodeWorkspaceFileRef, b: CodeWorkspaceFileRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "root"
    ? b.kind === "root" && a.rootId === b.rootId && a.path === b.path
    : b.kind === "loose" && a.id === b.id && a.path === b.path;
}

function fileRefUnder(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && (ref.path === path || ref.path.startsWith(`${path}/`));
}

function remapFileRef(ref: CodeWorkspaceFileRef, rootId: string, fromPath: string, toPath: string): CodeWorkspaceFileRef {
  if (ref.kind !== "root" || ref.rootId !== rootId) return ref;
  return { ...ref, path: remapRelativePath(ref.path, fromPath, toPath) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatMtime(mtime: number): string {
  if (!mtime) return "";
  try {
    return new Date(mtime * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function shouldHideEntry(entry: WorkspaceEntry): boolean {
  return entry.path === ".git" || entry.path.startsWith(".git/");
}

function isRootRef(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && ref.path === path;
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function lspPresetIdForPath(path: string): string | null {
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

function readLspCommandPrefs(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LSP_COMMAND_PREFS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLspCommandPrefs(prefs: Record<string, string>): void {
  try {
    window.localStorage.setItem(LSP_COMMAND_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
}

function readLspCustomCommands(): Record<string, LspCustomCommandConfig> {
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

function writeLspCustomCommands(commands: Record<string, LspCustomCommandConfig>): void {
  try {
    window.localStorage.setItem(LSP_CUSTOM_COMMANDS_KEY, JSON.stringify(commands));
  } catch {
    // Ignore storage failures.
  }
}

function splitCommandArgs(value: string): string[] {
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

function customServerCommandFromConfig(config?: LspCustomCommandConfig): LspCustomServerCommand | null {
  const command = config?.command.trim() ?? "";
  if (!command) return null;
  return {
    label: "Custom",
    command,
    args: splitCommandArgs(config?.args ?? ""),
  };
}

function emptyLspFileState(): LspFileState {
  return {
    status: null,
    diagnostics: [],
    syncing: false,
    syncedText: null,
    error: null,
  };
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#");
}

function normalizeRelativeLink(path: string): string {
  const clean = path.split("#", 1)[0].split("?", 1)[0].replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveRootMarkdownLink(currentPath: string, href: string): string {
  return normalizeRelativeLink(joinRelativePath(parentPath(currentPath), href));
}

function resolveLooseMarkdownLink(currentPath: string, href: string): string {
  const normalized = currentPath.replace(/\\/g, "/");
  return joinRelativePath(parentPath(normalized), href);
}

function makeLoadingFile(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): OpenFileState {
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

function fileMeta(ref: CodeWorkspaceFileRef, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]) {
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

function workspaceTitle(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): string {
  if (workspace.name?.trim()) return workspace.name.trim();
  if (roots.length === 1 && looseFiles.length === 0) return roots[0].name;
  if (roots.length === 0 && looseFiles.length > 0) return "Editor Workspace";
  return "Code Workspace";
}

function initialFileRef(workspace: CodeWorkspaceTabInfo, roots: CodeWorkspaceRootInfo[], looseFiles: CodeWorkspaceLooseFileInfo[]): CodeWorkspaceFileRef | null {
  if (workspace.initialFile) return workspace.initialFile;
  const initialPath = workspace.initialPath?.trim();
  if (initialPath && roots[0]) {
    return { kind: "root", rootId: roots[0].id, path: initialPath };
  }
  return looseFiles[0] ? { kind: "loose", id: looseFiles[0].id, path: looseFiles[0].path } : null;
}

export function CodeWorkspaceTab({
  tabId,
  workspace,
  visible = true,
}: CodeWorkspaceTabProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const [looseFiles, setLooseFiles] = useState<CodeWorkspaceLooseFileInfo[]>(() => initialLooseFiles(workspace));
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() => new Set(initialRoots(workspace).map((root) => root.id)));
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(initialRoots(workspace).map((root) => rootDirKey(root.id, ""))));
  const [treeFilter, setTreeFilter] = useState("");
  const [selected, setSelected] = useState<TreeSelection | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, OpenFileState>>({});
  const [openOrder, setOpenOrder] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [markdownModes, setMarkdownModes] = useState<Record<string, MarkdownViewMode>>({});
  const [lspFiles, setLspFiles] = useState<Record<string, LspFileState>>({});
  const [lspServerStatuses, setLspServerStatuses] = useState<LspServerStatus[]>([]);
  const [languagePanelOpen, setLanguagePanelOpen] = useState(true);
  const [referencesPanelOpen, setReferencesPanelOpen] = useState(true);
  const [lspCommandPrefs, setLspCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [lspCustomCommands, setLspCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(() => readLspCustomCommands());
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
  const lspFilesRef = useRef(lspFiles);
  const lspVersionRef = useRef<Record<string, number>>({});
  const revealNonceRef = useRef(0);
  const initialOpenedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    openOrderRef.current = openOrder;
  }, [openOrder]);

  useEffect(() => {
    lspFilesRef.current = lspFiles;
  }, [lspFiles]);

  const workspaceId = useMemo(
    () => workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId],
  );

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);

  const refreshLspServerStatuses = useCallback(async () => {
    try {
      setLspServerStatuses(await lspDetectServers());
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [setStatusMessage]);

  useEffect(() => {
    void refreshLspServerStatuses();
  }, [refreshLspServerStatuses]);

  const updateLspCommandPref = useCallback((presetId: string, commandId: string) => {
    setLspCommandPrefs((current) => {
      const next = { ...current, [presetId]: commandId };
      writeLspCommandPrefs(next);
      return next;
    });
    setLspFiles((current) => {
      const next: Record<string, LspFileState> = {};
      for (const [key, state] of Object.entries(current)) {
        next[key] = { ...state, syncedText: null };
      }
      return next;
    });
  }, []);

  const updateLspCustomCommand = useCallback((presetId: string, patch: Partial<LspCustomCommandConfig>) => {
    setLspCustomCommands((current) => {
      const existing = current[presetId] ?? { command: "", args: "" };
      const nextConfig = { ...existing, ...patch };
      const next = { ...current };
      if (nextConfig.command.trim() || nextConfig.args.trim()) next[presetId] = nextConfig;
      else delete next[presetId];
      writeLspCustomCommands(next);
      return next;
    });
    setLspFiles((current) => {
      const next: Record<string, LspFileState> = {};
      for (const [key, state] of Object.entries(current)) {
        next[key] = { ...state, syncedText: null };
      }
      return next;
    });
  }, []);

  const lspDescriptorForFile = useCallback(
    (file: OpenFileState): LspDocumentDescriptor | null => {
      const presetId = lspPresetIdForPath(file.languagePath);
      const commandPref = presetId ? lspCommandPrefs[presetId] ?? null : null;
      const serverCommandId = commandPref && commandPref !== CUSTOM_LSP_COMMAND_ID ? commandPref : null;
      const customServerCommand = presetId && commandPref === CUSTOM_LSP_COMMAND_ID
        ? customServerCommandFromConfig(lspCustomCommands[presetId])
        : null;
      if (file.ref.kind === "root") {
        const root = findRoot(file.ref.rootId);
        if (!root) return null;
        return {
          workspaceId,
          rootPath: root.path,
          filePath: file.ref.path,
          serverCommandId,
          customServerCommand,
        };
      }
      return {
        workspaceId,
        rootPath: null,
        filePath: file.ref.path,
        serverCommandId,
        customServerCommand,
      };
    },
    [findRoot, lspCommandPrefs, lspCustomCommands, workspaceId],
  );

  const nextLspVersion = useCallback((key: string) => {
    const next = (lspVersionRef.current[key] ?? 0) + 1;
    lspVersionRef.current[key] = next;
    return next;
  }, []);

  const refreshFileDiagnostics = useCallback(
    async (file: OpenFileState) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      try {
        const result = await lspGetDiagnostics(descriptor);
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            status: result.status,
            diagnostics: result.diagnostics,
            syncing: false,
            error: null,
          },
        }));
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            syncing: false,
            error: errorMessage(err),
          },
        }));
      }
    },
    [lspDescriptorForFile],
  );

  const syncLspDocument = useCallback(
    async (file: OpenFileState, mode: "open" | "change") => {
      if (file.loading) return;
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      const version = nextLspVersion(file.key);
      setLspFiles((current) => ({
        ...current,
        [file.key]: {
          ...(current[file.key] ?? emptyLspFileState()),
          syncing: true,
          error: null,
        },
      }));
      try {
        const status = mode === "open"
          ? await lspOpenDocument(descriptor, file.text, version)
          : await lspChangeDocument(descriptor, file.text, version);
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            status,
            diagnostics: current[file.key]?.diagnostics ?? [],
            syncing: false,
            syncedText: file.text,
            error: null,
          },
        }));
        window.setTimeout(() => {
          const latest = openFilesRef.current[file.key];
          if (latest) void refreshFileDiagnostics(latest);
        }, 500);
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            syncing: false,
            error: errorMessage(err),
          },
        }));
      }
    },
    [lspDescriptorForFile, nextLspVersion, refreshFileDiagnostics],
  );

  const saveLspDocument = useCallback(
    async (file: OpenFileState, text: string) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      try {
        const status = await lspSaveDocument(descriptor, text, lspVersionRef.current[file.key] ?? 0);
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            status,
            syncing: false,
            syncedText: text,
            error: null,
          },
        }));
        window.setTimeout(() => {
          const latest = openFilesRef.current[file.key];
          if (latest) void refreshFileDiagnostics(latest);
        }, 500);
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            syncing: false,
            syncedText: text,
            error: errorMessage(err),
          },
        }));
      }
    },
    [lspDescriptorForFile, refreshFileDiagnostics],
  );

  const loadDir = useCallback(
    async (rootId: string, path: string) => {
      const root = findRoot(rootId);
      if (!root) return;
      const key = rootDirKey(rootId, path);
      setDirectories((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? DEFAULT_DIR_STATE),
          loading: true,
          error: null,
        },
      }));
      try {
        const entries = await workspaceListDir(root.path, path);
        setDirectories((current) => ({
          ...current,
          [key]: {
            entries,
            loaded: true,
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        const message = errorMessage(err);
        setDirectories((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? DEFAULT_DIR_STATE),
            loaded: true,
            loading: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [findRoot, setStatusMessage],
  );

  useEffect(() => {
    roots.forEach((root) => {
      if (expandedRoots.has(root.id)) void loadDir(root.id, "");
    });
  }, [expandedRoots, loadDir, roots]);

  const openFile = useCallback(
    async (ref: CodeWorkspaceFileRef) => {
      const key = fileKey(ref);
      setActiveKey(key);
      setOpenOrder((current) => (current.includes(key) ? current : [...current, key]));
      if (openFilesRef.current[key] && !openFilesRef.current[key].loading) return;
      setOpenFiles((current) => ({
        ...current,
        [key]: current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current),
      }));
      try {
        const file = ref.kind === "root"
          ? await workspaceReadFile(findRoot(ref.rootId)?.path ?? "", ref.path)
          : await workspaceReadLooseFile(ref.path);
        const nextRef = ref.kind === "root" ? { ...ref, path: file.path } : { ...ref, path: file.path };
        const meta = fileMeta(nextRef, rootsRef.current, looseFilesRef.current);
        setOpenFiles((current) => {
          const next = { ...current };
          if (fileKey(nextRef) !== key) delete next[key];
          next[fileKey(nextRef)] = {
            ref: nextRef,
            key: fileKey(nextRef),
            path: meta.path,
            title: meta.title,
            subtitle: meta.subtitle,
            languagePath: meta.languagePath,
            text: file.text,
            savedText: file.text,
            hash: file.hash,
            mtime: file.mtime,
            size: file.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          };
          return next;
        });
        setOpenOrder((current) => current.map((item) => (item === key ? fileKey(nextRef) : item)));
        setActiveKey(fileKey(nextRef));
        setStatusMessage(`Opened ${meta.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? makeLoadingFile(ref, rootsRef.current, looseFilesRef.current)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [findRoot, setStatusMessage],
  );

  useEffect(() => {
    const ref = initialFileRef(workspace, roots, looseFiles);
    if (!ref) return;
    const key = fileKey(ref);
    if (initialOpenedKeyRef.current === key) return;
    initialOpenedKeyRef.current = key;
    void openFile(ref);
  }, [looseFiles, openFile, roots, workspace]);

  const addRoot = useCallback(async () => {
    const path = await selectFolderPath();
    if (!path) return;
    const root = makeRoot(path, "folder");
    if (rootsRef.current.some((item) => item.path === root.path)) {
      setStatusMessage(`Folder already in workspace: ${root.path}`);
      return;
    }
    setRoots((current) => [...current, root]);
    setExpandedRoots((current) => new Set(current).add(root.id));
    setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, "")));
    setStatusMessage(`Added folder ${root.path}`);
    void loadDir(root.id, "");
  }, [loadDir, setStatusMessage]);

  const addLooseFilePath = useCallback(async (path: string) => {
    if (!path) return;
    const file = makeLooseFile(path);
    setLooseFiles((current) => current.some((item) => item.path === file.path) ? current : [...current, file]);
    setSelected({ kind: "file", ref: { kind: "loose", id: file.id, path: file.path } });
    await openFile({ kind: "loose", id: file.id, path: file.path });
  }, [openFile]);

  const openLooseFile = useCallback(async () => {
    const path = await selectFilePath();
    if (!path) return;
    await addLooseFilePath(path);
  }, [addLooseFilePath]);

  const refreshTree = useCallback(() => {
    setDirectories({});
    rootsRef.current.forEach((root) => {
      if (expandedRoots.has(root.id)) void loadDir(root.id, "");
    });
  }, [expandedRoots, loadDir]);

  const toggleRoot = useCallback(
    (rootId: string) => {
      setSelected({ kind: "root", rootId });
      setExpandedRoots((current) => {
        const next = new Set(current);
        if (next.has(rootId)) next.delete(rootId);
        else next.add(rootId);
        return next;
      });
      if (!directories[rootDirKey(rootId, "")]?.loaded) void loadDir(rootId, "");
    },
    [directories, loadDir],
  );

  const toggleDir = useCallback(
    (rootId: string, path: string) => {
      const key = rootDirKey(rootId, path);
      const wasExpanded = expandedDirs.has(key);
      setExpandedDirs((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      const state = directories[key];
      if (!wasExpanded && (!state?.loaded || state.error)) {
        void loadDir(rootId, path);
      }
    },
    [directories, expandedDirs, loadDir],
  );

  const selectedRootDirectory = useMemo(() => {
    if (selected?.kind === "dir") return { rootId: selected.rootId, path: selected.path };
    if (selected?.kind === "file" && selected.ref.kind === "root") {
      return { rootId: selected.ref.rootId, path: parentPath(selected.ref.path) };
    }
    if (activeKey) {
      const active = openFiles[activeKey];
      if (active?.ref.kind === "root") return { rootId: active.ref.rootId, path: parentPath(active.ref.path) };
    }
    return roots[0] ? { rootId: roots[0].id, path: "" } : null;
  }, [activeKey, openFiles, roots, selected]);

  const createFile = useCallback(async () => {
    if (!selectedRootDirectory) {
      setStatusMessage("Add a folder before creating files");
      return;
    }
    const name = await promptAppDialog({
      title: "New file",
      label: "File name",
      initialValue: selectedRootDirectory.path ? `${selectedRootDirectory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(selectedRootDirectory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(selectedRootDirectory.path, name);
    try {
      const file = await workspaceCreateFile(root.path, path);
      await loadDir(root.id, parentPath(file.path));
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: file.path };
      setSelected({ kind: "file", ref });
      await openFile(ref);
      setStatusMessage(`Created ${root.name} / ${file.path}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, openFile, selectedRootDirectory, setStatusMessage]);

  const createDir = useCallback(async () => {
    if (!selectedRootDirectory) {
      setStatusMessage("Add a folder before creating directories");
      return;
    }
    const name = await promptAppDialog({
      title: "New directory",
      label: "Directory name",
      initialValue: selectedRootDirectory.path ? `${selectedRootDirectory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(selectedRootDirectory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(selectedRootDirectory.path, name);
    try {
      const entry = await workspaceCreateDir(root.path, path);
      await loadDir(root.id, parentPath(entry.path));
      setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, parentPath(entry.path))));
      setSelected({ kind: "dir", rootId: root.id, path: entry.path });
      setStatusMessage(`Created ${root.name} / ${entry.path}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, selectedRootDirectory, setStatusMessage]);

  const renameSelected = useCallback(async () => {
    if (!selected) return;
    if (selected.kind === "root") {
      const root = findRoot(selected.rootId);
      if (!root) return;
      const name = await promptAppDialog({ title: "Rename root", label: "Display name", initialValue: root.name });
      if (!name || name === root.name) return;
      setRoots((current) => current.map((item) => item.id === root.id ? { ...item, name } : item));
      return;
    }
    if (selected.kind === "file" && selected.ref.kind === "loose") {
      const ref = selected.ref;
      const loose = looseFilesRef.current.find((item) => item.id === ref.id);
      if (!loose) return;
      const name = await promptAppDialog({ title: "Rename loose file", label: "Display name", initialValue: loose.name });
      if (!name || name === loose.name) return;
      setLooseFiles((current) => current.map((item) => item.id === loose.id ? { ...item, name } : item));
      return;
    }
    const rootTarget = selected.kind === "dir"
      ? { rootId: selected.rootId, path: selected.path }
      : selected.ref.kind === "root"
        ? { rootId: selected.ref.rootId, path: selected.ref.path }
        : null;
    if (!rootTarget) return;
    const rootId = rootTarget.rootId;
    const selectedPath = rootTarget.path;
    const root = findRoot(rootId);
    if (!root) return;
    const nextName = await promptAppDialog({
      title: "Rename",
      label: "New name",
      initialValue: basename(selectedPath),
    });
    if (!nextName || nextName === basename(selectedPath)) return;
    const nextPath = joinRelativePath(parentPath(selectedPath), nextName);
    try {
      const entry = await workspaceRenamePath(root.path, selectedPath, nextPath);
      const newPath = entry.path;
      await loadDir(root.id, parentPath(selectedPath));
      await loadDir(root.id, parentPath(newPath));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          next.add(id === root.id ? rootDirKey(root.id, remapRelativePath(path, selectedPath, newPath)) : item);
        }
        return next;
      });
      setOpenFiles((current) => {
        const next: Record<string, OpenFileState> = {};
        for (const file of Object.values(current)) {
          const ref = remapFileRef(file.ref, root.id, selectedPath, newPath);
          const meta = fileMeta(ref, rootsRef.current, looseFilesRef.current);
          next[fileKey(ref)] = { ...file, ref, key: fileKey(ref), path: meta.path, title: meta.title, subtitle: meta.subtitle, languagePath: meta.languagePath };
        }
        return next;
      });
      setOpenOrder((current) => current.map((key) => {
        const file = openFilesRef.current[key];
        if (!file) return key;
        return fileKey(remapFileRef(file.ref, root.id, selectedPath, newPath));
      }));
      setActiveKey((current) => {
        const file = current ? openFilesRef.current[current] : null;
        return file ? fileKey(remapFileRef(file.ref, root.id, selectedPath, newPath)) : current;
      });
      setSelected(entry.fileType === "dir" ? { kind: "dir", rootId: root.id, path: newPath } : { kind: "file", ref: { kind: "root", rootId: root.id, path: newPath } });
      setStatusMessage(`Renamed to ${root.name} / ${newPath}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, selected, setStatusMessage]);

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    if (selected.kind === "root") {
      const root = findRoot(selected.rootId);
      if (!root) return;
      const confirmed = await confirmAppDialog({
        title: "Remove folder",
        message: `Remove ${root.name} from this workspace? Files on disk are not deleted.`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      const removedRootId = root.id;
      setRoots((current) => current.filter((item) => item.id !== removedRootId));
      setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${removedRootId}:`))));
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => file.ref.kind !== "root" || file.ref.rootId !== removedRootId)));
      const remaining = openOrderRef.current.filter((key) => {
        const file = openFilesRef.current[key];
        return !file || file.ref.kind !== "root" || file.ref.rootId !== removedRootId;
      });
      setOpenOrder(remaining);
      setActiveKey((current) => current && !remaining.includes(current) ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    if (selected.kind === "file" && selected.ref.kind === "loose") {
      const ref = selected.ref;
      const confirmed = await confirmAppDialog({
        title: "Remove loose file",
        message: `Remove ${ref.path} from this workspace? The file on disk is not deleted.`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      const key = fileKey(ref);
      setLooseFiles((current) => current.filter((item) => item.id !== ref.id));
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      const remaining = openOrderRef.current.filter((item) => item !== key);
      setOpenOrder(remaining);
      setActiveKey((current) => current === key ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    const rootTarget = selected.kind === "dir"
      ? { rootId: selected.rootId, path: selected.path }
      : selected.ref.kind === "root"
        ? { rootId: selected.ref.rootId, path: selected.ref.path }
        : null;
    if (!rootTarget) return;
    const rootId = rootTarget.rootId;
    const selectedPath = rootTarget.path;
    const root = findRoot(rootId);
    if (!root) return;
    const confirmed = await confirmAppDialog({
      title: "Delete",
      message: `Delete ${root.name} / ${selectedPath}?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await workspaceDeletePath(root.path, selectedPath, selected.kind === "dir");
      await loadDir(root.id, parentPath(selectedPath));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          if (id !== root.id || (path !== selectedPath && !path.startsWith(`${selectedPath}/`))) next.add(item);
        }
        return next;
      });
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => !fileRefUnder(file.ref, root.id, selectedPath))));
      const remainingOpen = openOrderRef.current.filter((key) => {
        const file = openFilesRef.current[key];
        return !file || !fileRefUnder(file.ref, root.id, selectedPath);
      });
      setOpenOrder(remainingOpen);
      setActiveKey((current) => {
        const file = current ? openFilesRef.current[current] : null;
        return file && fileRefUnder(file.ref, root.id, selectedPath) ? remainingOpen[0] ?? null : current;
      });
      setSelected(null);
      setStatusMessage(`Deleted ${root.name} / ${selectedPath}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [findRoot, loadDir, selected, setStatusMessage]);

  const updateFileText = useCallback((key: string, text: string) => {
    setOpenFiles((current) => {
      const file = current[key];
      if (!file || file.text === text) return current;
      return {
        ...current,
        [key]: {
          ...file,
          text,
          dirty: text !== file.savedText,
          error: null,
        },
      };
    });
  }, []);

  const saveFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file || file.loading || file.saving || !file.dirty) return;
      const textToSave = file.text;
      setOpenFiles((current) => ({
        ...current,
        [key]: { ...current[key], saving: true, error: null },
      }));
      try {
        const saved = file.ref.kind === "root"
          ? await workspaceWriteFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path, textToSave, file.hash)
          : await workspaceWriteLooseFile(file.ref.path, textToSave, file.hash);
        setOpenFiles((current) => {
          const latest = current[key];
          const latestText = latest?.text ?? saved.text;
          const changedWhileSaving = latestText !== textToSave;
          return {
            ...current,
            [key]: {
              ...file,
              text: changedWhileSaving ? latestText : saved.text,
              savedText: saved.text,
              hash: saved.hash,
              mtime: saved.mtime,
              size: saved.size,
              loading: false,
              saving: false,
              dirty: changedWhileSaving,
              error: null,
            },
          };
        });
        setStatusMessage(`Saved ${file.subtitle}`);
        void saveLspDocument(file, textToSave);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...current[key],
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activeKey, findRoot, saveLspDocument, setStatusMessage],
  );

  const reloadFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file) return;
      if (file.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? file),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = file.ref.kind === "root"
          ? await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
          : await workspaceReadLooseFile(file.ref.path);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...file,
            text: reloaded.text,
            savedText: reloaded.text,
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
        }));
        setStatusMessage(`Reloaded ${file.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? file),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activeKey, findRoot, setStatusMessage],
  );

  const closeFile = useCallback(
    async (key: string) => {
      const file = openFilesRef.current[key];
      if (file?.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Close file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Close",
          danger: true,
        });
        if (!confirmed) return;
      }
      const order = openOrderRef.current;
      const index = order.indexOf(key);
      const nextOrder = order.filter((entry) => entry !== key);
      if (file) {
        const descriptor = lspDescriptorForFile(file);
        if (descriptor) void lspCloseDocument(descriptor);
      }
      setOpenOrder(nextOrder);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setMarkdownModes((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setLspFiles((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete lspVersionRef.current[key];
      setActiveKey((current) => {
        if (current !== key) return current;
        return nextOrder[Math.min(index, nextOrder.length - 1)] ?? null;
      });
    },
    [lspDescriptorForFile],
  );

  const activeFile = activeKey ? openFiles[activeKey] ?? null : null;
  const activeLspState = activeKey ? lspFiles[activeKey] ?? null : null;
  const activeMarkdownMode = activeFile && isMarkdownPath(activeFile.languagePath)
    ? markdownModes[activeFile.key] ?? "edit"
    : "edit";

  useEffect(() => {
    if (!visible || !activeFile || activeFile.loading) return;
    const lspState = lspFilesRef.current[activeFile.key];
    if (lspState?.syncedText === activeFile.text && lspState.status) return;
    const mode: "open" | "change" = lspState?.status ? "change" : "open";
    const timer = window.setTimeout(() => {
      const latest = openFilesRef.current[activeFile.key];
      if (latest) void syncLspDocument(latest, mode);
    }, mode === "open" ? 0 : 350);
    return () => window.clearTimeout(timer);
  }, [activeFile, syncLspDocument, visible]);

  const setActiveMarkdownMode = useCallback((mode: MarkdownViewMode) => {
    if (!activeFile) return;
    setMarkdownModes((current) => ({ ...current, [activeFile.key]: mode }));
  }, [activeFile]);
  const openMarkdownHref = useCallback(
    (href: string) => {
      if (!activeFile || isExternalHref(href)) return false;
      const target = href.split("#", 1)[0].split("?", 1)[0];
      if (!target) return false;
      if (activeFile.ref.kind === "root") {
        const path = resolveRootMarkdownLink(activeFile.ref.path, target);
        void openFile({ kind: "root", rootId: activeFile.ref.rootId, path });
        return true;
      }
      const path = resolveLooseMarkdownLink(activeFile.ref.path, target);
      void addLooseFilePath(path);
      return true;
    },
    [activeFile, addLooseFilePath, openFile],
  );

  const updateLspStatusForFile = useCallback((file: OpenFileState, status: LspDocumentStatus) => {
    setLspFiles((current) => ({
      ...current,
      [file.key]: {
        ...(current[file.key] ?? emptyLspFileState()),
        status,
        syncing: false,
        error: null,
      },
    }));
  }, []);

  const revealEditorLocation = useCallback((key: string, range: LspLocation["range"]) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: range.start.line,
      character: range.start.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  const openLspLocation = useCallback(
    async (location: LspLocation) => {
      const path = location.path;
      if (!path) return false;
      for (const root of rootsRef.current) {
        const relative = relativePathWithinRoot(root.path, path);
        if (relative === null) continue;
        const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relative };
        revealEditorLocation(fileKey(ref), location.range);
        await openFile(ref);
        return true;
      }
      const loose = makeLooseFile(path);
      const ref: CodeWorkspaceFileRef = { kind: "loose", id: loose.id, path: loose.path };
      setLooseFiles((current) => current.some((item) => item.path === loose.path) ? current : [...current, loose]);
      revealEditorLocation(fileKey(ref), location.range);
      await openFile(ref);
      return true;
    },
    [openFile, revealEditorLocation],
  );

  const getLspHover = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      try {
        const result = await lspHover(descriptor, position);
        updateLspStatusForFile(file, result.status);
        return result.contents;
      } catch (err) {
        setLspFiles((current) => ({
          ...current,
          [file.key]: {
            ...(current[file.key] ?? emptyLspFileState()),
            error: errorMessage(err),
          },
        }));
        return null;
      }
    },
    [lspDescriptorForFile, updateLspStatusForFile],
  );

  const goToDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return false;
      try {
        const result = await lspDefinition(descriptor, position);
        updateLspStatusForFile(file, result.status);
        const first = result.locations[0];
        if (!first) {
          setStatusMessage("No definition found");
          return false;
        }
        await openLspLocation(first);
        return true;
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [lspDescriptorForFile, openLspLocation, setStatusMessage, updateLspStatusForFile],
  );

  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      setReferencesPanelOpen(true);
      setReferencesResult({
        loading: true,
        origin: file.subtitle,
        locations: [],
        error: null,
      });
      try {
        const result = await lspReferences(descriptor, position, true);
        updateLspStatusForFile(file, result.status);
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: result.locations,
          error: null,
        });
        setStatusMessage(`${result.locations.length} reference${result.locations.length === 1 ? "" : "s"} found`);
      } catch (err) {
        setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: errorMessage(err),
        });
      }
    },
    [lspDescriptorForFile, setStatusMessage, updateLspStatusForFile],
  );

  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [openFiles, openOrder],
  );
  const activeDiagnostics = activeLspState?.diagnostics ?? [];
  const title = workspaceTitle(workspace, roots, looseFiles);

  useEffect(() => {
    const firstRoot = roots[0] ?? null;
    const openStates = openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file);
    const toContextFile = (file: OpenFileState) => {
      const ref = file.ref;
      if (ref.kind === "root") {
        const root = roots.find((item) => item.id === ref.rootId);
        return {
          kind: "root" as const,
          rootId: ref.rootId,
          rootName: root?.name,
          rootPath: root?.path,
          path: ref.path,
        };
      }
      const loose = looseFiles.find((item) => item.id === ref.id);
      return {
        kind: "loose" as const,
        id: ref.id,
        name: loose?.name,
        path: ref.path,
      };
    };
    const lspDiagnostics = openStates
      .map((file) => {
        const diagnostics = lspFiles[file.key]?.diagnostics ?? [];
        if (diagnostics.length === 0) return null;
        return {
          file: toContextFile(file),
          errorCount: diagnostics.filter((item) => item.severity === 1).length,
          warningCount: diagnostics.filter((item) => item.severity === 2).length,
          infoCount: diagnostics.filter((item) => item.severity !== 1 && item.severity !== 2).length,
          messages: diagnostics
            .slice()
            .sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99))
            .slice(0, 5)
            .map((item) => item.message),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const activeStatus = activeLspState?.status
      ? {
          displayName: activeLspState.status.displayName,
          languageId: activeLspState.status.languageId,
          active: activeLspState.status.active,
          available: activeLspState.status.available,
          selectedCommand: activeLspState.status.selectedCommand,
          installHint: activeLspState.status.installHint,
          error: activeLspState.status.error ?? activeLspState.error,
        }
      : null;
    const lspContext = activeStatus || lspDiagnostics.length > 0
      ? {
          activeStatus,
          diagnostics: lspDiagnostics,
        }
      : null;
    setTabCodeWorkspaceContext(tabId, {
      repoRoot: firstRoot?.path ?? workspace.repoRoot ?? "",
      activePath: activeFile?.ref.kind === "root" && activeFile.ref.rootId === firstRoot?.id ? activeFile.ref.path : null,
      openPaths: firstRoot ? openStates.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      dirtyPaths: firstRoot ? dirtyFiles.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      roots,
      looseFiles,
      activeFile: activeFile ? toContextFile(activeFile) : null,
      openFiles: openStates.map(toContextFile),
      dirtyFiles: dirtyFiles.map(toContextFile),
      lsp: lspContext,
    });
  }, [activeFile, activeLspState, dirtyFiles, looseFiles, lspFiles, openFiles, openOrder, roots, setTabCodeWorkspaceContext, tabId, workspace.repoRoot]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);

  function renderEntries(root: CodeWorkspaceRootInfo, path: string, depth: number): ReactNode {
    const state = directories[rootDirKey(root.id, path)] ?? DEFAULT_DIR_STATE;
    const filter = treeFilter.trim().toLowerCase();
    if (state.loading && !state.loaded) {
      return (
        <div className="h-7 flex items-center gap-2 px-2 text-[12px] text-[var(--taomni-text-muted)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Loading</span>
        </div>
      );
    }
    if (state.error) {
      return (
        <div className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-500">
          {state.error}
        </div>
      );
    }
    const entries = state.entries.filter((entry) => {
      if (shouldHideEntry(entry)) return false;
      if (!filter) return true;
      return entry.name.toLowerCase().includes(filter) || entry.path.toLowerCase().includes(filter);
    });
    if (entries.length === 0) {
      return (
        <div className="px-3 py-2 text-[12px] text-[var(--taomni-text-muted)]">
          Empty
        </div>
      );
    }
    return entries.map((entry) => {
      const isDir = entry.fileType === "dir";
      const dirKey = rootDirKey(root.id, entry.path);
      const isExpanded = expandedDirs.has(dirKey);
      const rowStyle = { paddingLeft: `${10 + depth * 14}px` };
      if (isDir) {
        const childState = directories[dirKey];
        const isSelected = selected?.kind === "dir" && selected.rootId === root.id && selected.path === entry.path;
        return (
          <Fragment key={`${root.id}:${entry.path}`}>
            <button
              type="button"
              data-testid="code-workspace-tree-dir"
              data-root-id={root.id}
              data-path={entry.path}
              data-selected={isSelected || undefined}
              className="h-7 w-full min-w-0 flex items-center gap-1.5 pr-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] data-[selected=true]:bg-[var(--taomni-hover)]"
              style={rowStyle}
              title={`${root.name} / ${entry.path}`}
              onClick={() => {
                setSelected({ kind: "dir", rootId: root.id, path: entry.path });
                toggleDir(root.id, entry.path);
              }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
              )}
              <Folder className="w-3.5 h-3.5 shrink-0 text-[#d59d32]" />
              <span className="truncate">{entry.name}</span>
              {childState?.loading && <Loader2 className="ml-auto w-3 h-3 animate-spin" />}
            </button>
            {isExpanded && renderEntries(root, entry.path, depth + 1)}
          </Fragment>
        );
      }
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: entry.path };
      const key = fileKey(ref);
      const active = activeKey === key;
      const isSelected = selected?.kind === "file" && isRootRef(selected.ref, root.id, entry.path);
      const open = openFiles[key];
      return (
        <button
          key={`${root.id}:${entry.path}`}
          type="button"
          data-testid="code-workspace-tree-file"
          data-root-id={root.id}
          data-path={entry.path}
          data-active={active || undefined}
          data-selected={isSelected || undefined}
          className="h-7 w-full min-w-0 flex items-center gap-1.5 pr-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)] data-[selected=true]:bg-[var(--taomni-hover)]"
          style={rowStyle}
          title={`${root.name} / ${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
          onClick={() => {
            setSelected({ kind: "file", ref });
            void openFile(ref);
          }}
        >
          <span className="w-3.5 shrink-0" />
          <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
          <span className="truncate">{entry.name}</span>
          {open?.dirty && <span className="ml-auto text-[var(--taomni-accent)]">*</span>}
        </button>
      );
    });
  }

  return (
    <div
      data-testid="code-workspace-tab"
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[620px]">
            {roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : "No project roots"}
            {looseFiles.length > 0 ? ` · ${looseFiles.length} loose file${looseFiles.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded px-1.5 py-0.5 text-[11px] bg-[var(--taomni-selected)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        <div className="flex-1" />
        <IconButton
          label="Save"
          icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
          onClick={() => void saveFile()}
        />
        <IconButton
          label="Reload"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={!activeFile || activeFile.loading}
          onClick={() => void reloadFile()}
        />
        <IconButton
          label="Refresh tree"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={refreshTree}
        />
      </header>

      <PanelGroup
        orientation="horizontal"
        id={`code-workspace-${workspace.workspaceId ?? workspace.repoRoot ?? tabId}`}
        className="flex-1 min-h-0"
      >
        <Panel id="project" defaultSize="24%" minSize="15%" maxSize="45%" className="min-w-0">
          <aside className="h-full min-h-0 flex flex-col border-r border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
            <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
              <Search className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
              <input
                value={treeFilter}
                onChange={(event) => setTreeFilter(event.target.value)}
                placeholder="Filter"
                className="min-w-0 flex-1 bg-transparent outline-none text-[12px]"
              />
              <IconButton label="Open file" icon={<File className="w-3.5 h-3.5" />} onClick={() => void openLooseFile()} />
              <IconButton label="Add folder" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => void addRoot()} />
              <IconButton label="New file" icon={<FilePlus className="w-3.5 h-3.5" />} disabled={!selectedRootDirectory} onClick={() => void createFile()} />
              <IconButton label="New directory" icon={<FolderPlus className="w-3.5 h-3.5" />} disabled={!selectedRootDirectory} onClick={() => void createDir()} />
              <IconButton label="Rename" icon={<Pencil className="w-3.5 h-3.5" />} disabled={!selected} onClick={() => void renameSelected()} />
              <IconButton label="Delete or remove" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={!selected} onClick={() => void deleteSelected()} />
            </div>
            <div data-testid="code-workspace-tree" className="flex-1 min-h-0 overflow-auto py-1">
              {roots.length === 0 && looseFiles.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-[var(--taomni-text-muted)]">
                  Open a file or add a folder
                </div>
              )}
              {roots.map((root) => {
                const expanded = expandedRoots.has(root.id);
                const selectedRoot = selected?.kind === "root" && selected.rootId === root.id;
                return (
                  <Fragment key={root.id}>
                    <button
                      type="button"
                      data-testid="code-workspace-tree-root"
                      data-root-id={root.id}
                      data-selected={selectedRoot || undefined}
                      className="h-7 w-full min-w-0 flex items-center gap-1.5 px-2 text-left text-[12px] font-semibold hover:bg-[var(--taomni-hover)] data-[selected=true]:bg-[var(--taomni-hover)]"
                      title={root.path}
                      onClick={() => toggleRoot(root.id)}
                    >
                      {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                      )}
                      <Folder className="w-3.5 h-3.5 shrink-0 text-[#d59d32]" />
                      <span className="truncate">{root.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--taomni-text-muted)]">{root.kind}</span>
                    </button>
                    {expanded && renderEntries(root, "", 1)}
                  </Fragment>
                );
              })}
              {looseFiles.length > 0 && (
                <div className="mt-1">
                  <div className="h-6 flex items-center gap-1.5 px-2 text-[11px] font-semibold text-[var(--taomni-text-muted)]">
                    <File className="w-3.5 h-3.5" />
                    <span>Loose Files</span>
                  </div>
                  {looseFiles.map((file) => {
                    const ref: CodeWorkspaceFileRef = { kind: "loose", id: file.id, path: file.path };
                    const key = fileKey(ref);
                    const open = openFiles[key];
                    const active = activeKey === key;
                    const selectedLoose = selected?.kind === "file" && fileRefEquals(selected.ref, ref);
                    return (
                      <button
                        key={file.id}
                        type="button"
                        data-testid="code-workspace-tree-loose-file"
                        data-path={file.path}
                        data-active={active || undefined}
                        data-selected={selectedLoose || undefined}
                        className="h-7 w-full min-w-0 flex items-center gap-1.5 pl-6 pr-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)] data-[selected=true]:bg-[var(--taomni-hover)]"
                        title={file.path}
                        onClick={() => {
                          setSelected({ kind: "file", ref });
                          void openFile(ref);
                        }}
                      >
                        <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                        <span className="truncate">{file.name}</span>
                        {open?.dirty && <span className="ml-auto text-[var(--taomni-accent)]">*</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <ReferencesPanel
              open={referencesPanelOpen}
              result={referencesResult}
              roots={roots}
              onToggle={() => setReferencesPanelOpen((value) => !value)}
              onOpenLocation={(location) => void openLspLocation(location)}
            />
            <LanguageServersPanel
              open={languagePanelOpen}
              statuses={lspServerStatuses}
              activeStatus={activeLspState?.status ?? null}
              commandPrefs={lspCommandPrefs}
              customCommands={lspCustomCommands}
              onToggle={() => setLanguagePanelOpen((value) => !value)}
              onRefresh={() => void refreshLspServerStatuses()}
              onCommandChange={updateLspCommandPref}
              onCustomCommandChange={updateLspCustomCommand}
            />
          </aside>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="editor" defaultSize="76%" minSize="35%" className="min-w-0">
          <main className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)]">
            {openOrder.length > 0 && (
              <div className="h-8 shrink-0 flex items-end overflow-x-auto border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
                {openOrder.map((key) => {
                  const file = openFiles[key];
                  if (!file) return null;
                  const active = key === activeKey;
                  return (
                    <div
                      key={key}
                      data-active={active || undefined}
                      className="h-7 min-w-[130px] max-w-[240px] flex items-center border-r border-[var(--taomni-divider)] text-[12px] data-[active=true]:bg-[var(--taomni-code-bg)]"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-hover)]"
                        title={file.subtitle}
                        onClick={() => setActiveKey(key)}
                      >
                        <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                        <span className="truncate">{file.title}</span>
                        {file.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                      </button>
                      <button
                        type="button"
                        className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-hover)]"
                        title="Close"
                        onClick={() => void closeFile(key)}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex-1 min-h-0 relative">
              {activeFile ? (
                <div className="absolute inset-0 flex flex-col">
                  <div className="h-7 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[11px] text-[var(--taomni-text-muted)]">
                    <span className="truncate">{activeFile.subtitle}</span>
                    <span className="shrink-0">{formatBytes(activeFile.size)}</span>
                    {formatMtime(activeFile.mtime) && (
                      <span className="shrink-0">{formatMtime(activeFile.mtime)}</span>
                    )}
                    {activeFile.loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {activeLspState?.syncing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <LspStatusPill state={activeLspState} diagnostics={activeDiagnostics} />
                    {isMarkdownPath(activeFile.languagePath) && (
                      <div className="ml-auto flex items-center gap-0.5">
                        <ModeButton
                          label="Edit"
                          active={activeMarkdownMode === "edit"}
                          icon={<File className="w-3 h-3" />}
                          onClick={() => setActiveMarkdownMode("edit")}
                        />
                        <ModeButton
                          label="Preview"
                          active={activeMarkdownMode === "preview"}
                          icon={<Eye className="w-3 h-3" />}
                          onClick={() => setActiveMarkdownMode("preview")}
                        />
                        <ModeButton
                          label="Split"
                          active={activeMarkdownMode === "split"}
                          icon={<Columns2 className="w-3 h-3" />}
                          onClick={() => setActiveMarkdownMode("split")}
                        />
                      </div>
                    )}
                  </div>
                  {activeFile.error && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-[12px] text-red-500">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span className="min-w-0 truncate">{activeFile.error}</span>
                    </div>
                  )}
                  <div data-testid="code-workspace-editor" className="flex-1 min-h-0">
                    {activeFile.loading ? (
                      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "preview" ? (
                      <MarkdownPreview file={activeFile} onOpenHref={openMarkdownHref} />
                    ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "split" ? (
                      <div className="h-full min-h-0 grid grid-cols-2">
                        <div className="min-w-0 min-h-0 border-r border-[var(--taomni-divider)]">
                          <WorkspaceCodeEditor
                            key={`${activeFile.key}:edit`}
                            path={activeFile.languagePath}
                            doc={activeFile.text}
                            visible={visible}
                            diagnostics={activeDiagnostics}
                            reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                            onChange={(doc) => updateFileText(activeFile.key, doc)}
                            onSave={() => void saveFile(activeFile.key)}
                            onHover={(position) => getLspHover(activeFile, position)}
                            onDefinition={(position) => goToDefinition(activeFile, position)}
                            onReferences={(position) => findReferences(activeFile, position)}
                          />
                        </div>
                        <MarkdownPreview file={activeFile} onOpenHref={openMarkdownHref} />
                      </div>
                    ) : (
                      <WorkspaceCodeEditor
                        key={activeFile.key}
                        path={activeFile.languagePath}
                        doc={activeFile.text}
                        visible={visible}
                        diagnostics={activeDiagnostics}
                        reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                        onChange={(doc) => updateFileText(activeFile.key, doc)}
                        onSave={() => void saveFile(activeFile.key)}
                        onHover={(position) => getLspHover(activeFile, position)}
                        onDefinition={(position) => goToDefinition(activeFile, position)}
                        onReferences={(position) => findReferences(activeFile, position)}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  No file open
                </div>
              )}
            </div>
          </main>
        </Panel>
      </PanelGroup>
    </div>
  );
}

interface WorkspaceCodeEditorProps {
  path: string;
  doc: string;
  visible: boolean;
  diagnostics: LspDiagnostic[];
  reveal: EditorRevealTarget | null;
  onChange: (doc: string) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<string | null>;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
}

const LSP_EDITOR_STYLE = EditorView.theme({
  ".cm-lsp-diagnostic-error": {
    textDecoration: "underline wavy #ef4444 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-warning": {
    textDecoration: "underline wavy #f59e0b 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-info": {
    textDecoration: "underline dotted #38bdf8 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-hover": {
    maxWidth: "520px",
    maxHeight: "320px",
    overflow: "auto",
    padding: "8px 10px",
    border: "1px solid var(--taomni-divider)",
    background: "var(--taomni-bg)",
    color: "var(--taomni-text)",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.28)",
    fontSize: "12px",
    lineHeight: "1.5",
  },
});

function offsetFromLspPosition(doc: Text, position: LspPosition): number {
  if (doc.lines === 0) return 0;
  const lineNo = Math.min(doc.lines, Math.max(1, position.line + 1));
  const line = doc.line(lineNo);
  return Math.min(line.to, line.from + Math.max(0, position.character));
}

function lspPositionFromOffset(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, offset)));
  return {
    line: line.number - 1,
    character: offset - line.from,
  };
}

function diagnosticClass(severity: number | null): string {
  if (severity === 1) return "cm-lsp-diagnostic-error";
  if (severity === 2) return "cm-lsp-diagnostic-warning";
  return "cm-lsp-diagnostic-info";
}

function diagnosticDecorations(view: EditorView, diagnostics: LspDiagnostic[]): DecorationSet {
  const ranges = diagnostics.flatMap((diagnostic) => {
    const from = offsetFromLspPosition(view.state.doc, diagnostic.range.start);
    const rawTo = offsetFromLspPosition(view.state.doc, diagnostic.range.end);
    const to = Math.max(rawTo, Math.min(view.state.doc.length, from + 1));
    if (from > view.state.doc.length || to < from) return [];
    return Decoration.mark({
      class: diagnosticClass(diagnostic.severity),
      attributes: { title: diagnostic.message },
    }).range(from, to);
  });
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

function lspDiagnosticsExtension(diagnostics: LspDiagnostic[]): Extension {
  return EditorView.decorations.of((view) => diagnosticDecorations(view, diagnostics));
}

function lspInteractionExtensions(
  hoverRef: MutableRefObject<(position: LspPosition) => Promise<string | null>>,
  definitionRef: MutableRefObject<(position: LspPosition) => Promise<boolean>>,
  referencesRef: MutableRefObject<(position: LspPosition) => Promise<void>>,
): Extension[] {
  const definitionAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void definitionRef.current(position);
    return true;
  };
  const referencesAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void referencesRef.current(position);
    return true;
  };
  return [
    hoverTooltip((view, pos): Promise<Tooltip | null> => {
      const position = lspPositionFromOffset(view.state.doc, pos);
      return hoverRef.current(position).then((contents) => {
        if (!contents) return null;
        return {
          pos,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-hover taomni-chat-md";
            dom.innerHTML = renderFormatted(contents, "md") ?? "";
            return { dom };
          },
        };
      });
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void definitionRef.current(lspPositionFromOffset(view.state.doc, pos));
        return true;
      },
    }),
    keymap.of([
      { key: "F12", run: definitionAtSelection },
      { key: "Shift-F12", run: referencesAtSelection },
    ]),
  ];
}

function MarkdownPreview({
  file,
  onOpenHref,
}: {
  file: OpenFileState;
  onOpenHref: (href: string) => boolean;
}) {
  const html = useMemo(() => renderFormatted(file.text, "md") ?? "", [file.text]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll("pre > code.language-mermaid, pre > code.lang-mermaid"));
    if (blocks.length === 0) return;
    let cancelled = false;
    ensureMermaidReady();
    blocks.forEach((block, index) => {
      const source = block.textContent ?? "";
      const pre = block.parentElement;
      if (!pre) return;
      const wrapper = document.createElement("div");
      wrapper.className = "my-3 border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]";
      const toolbar = document.createElement("div");
      toolbar.className = "h-8 flex items-center gap-1 border-b border-[var(--taomni-divider)] px-2";
      const label = document.createElement("span");
      label.className = "min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--taomni-text-muted)]";
      label.textContent = `Mermaid ${index + 1}`;
      const svgButton = document.createElement("button");
      svgButton.type = "button";
      svgButton.className = "h-5 px-1.5 rounded text-[10px] hover:bg-[var(--taomni-hover)]";
      svgButton.textContent = "SVG";
      const pngButton = document.createElement("button");
      pngButton.type = "button";
      pngButton.className = "h-5 px-1.5 rounded text-[10px] hover:bg-[var(--taomni-hover)]";
      pngButton.textContent = "PNG";
      const diagram = document.createElement("div");
      diagram.className = "overflow-auto p-3";
      toolbar.append(label, svgButton, pngButton);
      wrapper.append(toolbar, diagram);
      pre.replaceWith(wrapper);

      void mermaid
        .render(`taomni-mermaid-${hashString(file.key)}-${hashString(source)}-${index}`, source)
        .then((result) => {
          if (cancelled) return;
          diagram.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          }) as unknown as string;
          const svg = diagram.querySelector("svg");
          if (!(svg instanceof SVGSVGElement)) return;
          svg.classList.add("max-w-full");
          svgButton.onclick = () => exportMermaidSvg(svg, `${file.title || "diagram"}-${index + 1}.svg`);
          pngButton.onclick = () => exportMermaidPng(svg, `${file.title || "diagram"}-${index + 1}.png`);
        })
        .catch((err) => {
          if (cancelled) return;
          diagram.className = "p-3 text-[12px] text-red-500";
          diagram.textContent = errorMessage(err);
        });
    });
    return () => {
      cancelled = true;
    };
  });

  return (
    <div
      ref={rootRef}
      data-testid="code-workspace-markdown-preview"
      className="taomni-chat-md h-full min-h-0 overflow-auto bg-[var(--taomni-bg)] px-5 py-4 text-[13px] leading-6"
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const anchor = target.closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        if (onOpenHref(href)) {
          event.preventDefault();
        }
      }}
    >
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function WorkspaceCodeEditor({
  path,
  doc,
  visible,
  diagnostics,
  reveal,
  onChange,
  onSave,
  onHover,
  onDefinition,
  onReferences,
}: WorkspaceCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onHoverRef = useRef(onHover);
  const onDefinitionRef = useRef(onDefinition);
  const onReferencesRef = useRef(onReferences);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;

  useEffect(() => {
    if (!hostRef.current) return;
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey)),
        }),
        crosshairCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        languageCompartment.current.of([]),
        diagnosticsCompartment.current.of(lspDiagnosticsExtension(diagnostics)),
        ...lspInteractionExtensions(onHoverRef, onDefinitionRef, onReferencesRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        keymap.of([
          { key: "Mod-s", run: saveHandler },
          { key: "Shift-Alt-ArrowUp", run: addCursorAbove },
          { key: "Shift-Alt-ArrowDown", run: addCursorBelow },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(lspDiagnosticsExtension(diagnostics)),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === doc) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: doc },
    });
  }, [doc]);

  useEffect(() => {
    if (!visible) return;
    viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const pos = offsetFromLspPosition(view.state.doc, {
      line: reveal.line,
      character: reveal.character,
    });
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [reveal]);

  return <div ref={hostRef} className="h-full w-full" />;
}

function ModeButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-active={active || undefined}
      className="h-5 min-w-5 px-1 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function LspStatusPill({
  state,
  diagnostics,
}: {
  state: LspFileState | null;
  diagnostics: LspDiagnostic[];
}) {
  if (!state?.status) {
    return (
      <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">
        LSP idle
      </span>
    );
  }
  const status = state.status;
  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;
  const label = status.active
    ? `${status.displayName ?? "LSP"}${errors || warnings ? ` · ${errors}E ${warnings}W` : ""}`
    : status.installHint
      ? `Install: ${status.installHint}`
      : status.error ?? "No LSP";
  return (
    <span
      title={label}
      data-active={status.active || undefined}
      data-error={!!state.error || (!status.active && !!status.error) || undefined}
      className="max-w-[38%] shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)] data-[active=true]:text-[var(--taomni-accent)] data-[error=true]:text-amber-500"
    >
      {label}
    </span>
  );
}

function displayLocationPath(location: LspLocation, roots: CodeWorkspaceRootInfo[]): string {
  const path = location.path ?? location.uri;
  for (const root of roots) {
    const relative = location.path ? relativePathWithinRoot(root.path, location.path) : null;
    if (relative !== null) return `${root.name}/${relative}`;
  }
  return path;
}

function ReferencesPanel({
  open,
  result,
  roots,
  onToggle,
  onOpenLocation,
}: {
  open: boolean;
  result: ReferencesResultState;
  roots: CodeWorkspaceRootInfo[];
  onToggle: () => void;
  onOpenLocation: (location: LspLocation) => void;
}) {
  return (
    <section className="shrink-0 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
      <button
        type="button"
        className="h-7 w-full min-w-0 flex items-center gap-1.5 px-2 text-left text-[11px] font-semibold hover:bg-[var(--taomni-hover)]"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <ListTree className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
        <span className="min-w-0 flex-1 truncate">References</span>
        {result.loading ? (
          <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
        ) : result.locations.length > 0 ? (
          <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{result.locations.length}</span>
        ) : null}
      </button>
      {open && (
        <div className="max-h-52 overflow-auto pb-1 text-[11px]">
          {result.origin && (
            <div className="truncate px-2 py-1 text-[10px] text-[var(--taomni-text-muted)]" title={result.origin}>
              {result.origin}
            </div>
          )}
          {result.error && (
            <div className="mx-2 mb-1 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-500">
              {result.error}
            </div>
          )}
          {!result.loading && !result.error && result.locations.length === 0 && (
            <div className="px-2 py-1.5 text-[var(--taomni-text-muted)]">No references</div>
          )}
          {result.locations.map((location, index) => {
            const label = displayLocationPath(location, roots);
            return (
              <button
                key={`${location.uri}:${location.range.start.line}:${location.range.start.character}:${index}`}
                type="button"
                className="w-full min-w-0 flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--taomni-hover)]"
                title={`${label}:${location.range.start.line + 1}:${location.range.start.character + 1}`}
                onClick={() => onOpenLocation(location)}
              >
                <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-text-muted)]">
                  {location.range.start.line + 1}:{location.range.start.character + 1}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LanguageServersPanel({
  open,
  statuses,
  activeStatus,
  commandPrefs,
  customCommands,
  onToggle,
  onRefresh,
  onCommandChange,
  onCustomCommandChange,
}: {
  open: boolean;
  statuses: LspServerStatus[];
  activeStatus: LspDocumentStatus | null;
  commandPrefs: Record<string, string>;
  customCommands: Record<string, LspCustomCommandConfig>;
  onToggle: () => void;
  onRefresh: () => void;
  onCommandChange: (presetId: string, commandId: string) => void;
  onCustomCommandChange: (presetId: string, patch: Partial<LspCustomCommandConfig>) => void;
}) {
  const missingCount = statuses.filter((status) => !status.available).length;
  return (
    <section className="shrink-0 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
      <div className="h-7 flex items-center text-[11px] font-semibold">
        <button
          type="button"
          className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-hover)]"
          onClick={onToggle}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Server className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
          <span className="min-w-0 flex-1 truncate">Language Servers</span>
          {missingCount > 0 && (
            <span className="shrink-0 text-[10px] text-amber-500">{missingCount} missing</span>
          )}
        </button>
        <button
          type="button"
          title="Refresh language servers"
          aria-label="Refresh language servers"
          className="mr-1 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          onClick={onRefresh}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <div className="max-h-56 overflow-auto pb-1">
          {activeStatus && (
            <div className="px-2 py-1 border-b border-[var(--taomni-divider)] text-[11px]">
              <div className="flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  Active: {activeStatus.displayName ?? "None"}
                </span>
              </div>
              {!activeStatus.active && activeStatus.installHint && (
                <div className="mt-1 truncate font-mono text-[10px] text-amber-500" title={activeStatus.installHint}>
                  {activeStatus.installHint}
                </div>
              )}
            </div>
          )}
          {statuses.map((status) => {
            const custom = customCommands[status.presetId] ?? { command: "", args: "" };
            const selected = commandPrefs[status.presetId] ?? status.selectedCommandId ?? status.commands[0]?.id ?? "";
            return (
              <div key={status.presetId} className="px-2 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span
                    data-available={status.available || undefined}
                    className="h-2 w-2 shrink-0 rounded-full bg-amber-500 data-[available=true]:bg-[var(--taomni-accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{status.displayName}</span>
                  {status.active && <span className="shrink-0 text-[10px] text-[var(--taomni-accent)]">active</span>}
                </div>
                <select
                  value={selected}
                  className="mt-1 h-6 w-full rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-1 text-[11px] outline-none"
                  onChange={(event) => onCommandChange(status.presetId, event.target.value)}
                  aria-label={`${status.displayName} language server command`}
                >
                  {status.commands.map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.label}{command.fallback ? " fallback" : ""}
                    </option>
                  ))}
                  <option value={CUSTOM_LSP_COMMAND_ID}>Custom command</option>
                </select>
                {selected === CUSTOM_LSP_COMMAND_ID && (
                  <div className="mt-1 grid grid-cols-1 gap-1">
                    <input
                      value={custom.command}
                      className="h-6 min-w-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-1 font-mono text-[11px] outline-none"
                      placeholder="Command or absolute path"
                      aria-label={`${status.displayName} custom command`}
                      onChange={(event) => onCustomCommandChange(status.presetId, { command: event.target.value })}
                    />
                    <input
                      value={custom.args}
                      className="h-6 min-w-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-1 font-mono text-[11px] outline-none"
                      placeholder="Args"
                      aria-label={`${status.displayName} custom args`}
                      onChange={(event) => onCustomCommandChange(status.presetId, { args: event.target.value })}
                    />
                  </div>
                )}
                {!status.available && (
                  <div className="mt-1 truncate font-mono text-[10px] text-amber-500" title={status.installHint}>
                    {status.installHint}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IconButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
