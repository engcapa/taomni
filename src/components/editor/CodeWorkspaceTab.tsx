import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
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
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
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
import { selectFilePath, selectFolderPath } from "../../lib/ipc";
import { codeViewExtensions } from "../../lib/codeViewTheme";
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

type TreeSelection =
  | { kind: "root"; rootId: string }
  | { kind: "dir"; rootId: string; path: string }
  | { kind: "file"; ref: CodeWorkspaceFileRef };

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
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
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

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);

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

  const openLooseFile = useCallback(async () => {
    const path = await selectFilePath();
    if (!path) return;
    const file = makeLooseFile(path);
    setLooseFiles((current) => current.some((item) => item.path === file.path) ? current : [...current, file]);
    setSelected({ kind: "file", ref: { kind: "loose", id: file.id, path: file.path } });
    await openFile({ kind: "loose", id: file.id, path: file.path });
  }, [openFile]);

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
    [activeKey, findRoot, setStatusMessage],
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
      setOpenOrder(nextOrder);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setActiveKey((current) => {
        if (current !== key) return current;
        return nextOrder[Math.min(index, nextOrder.length - 1)] ?? null;
      });
    },
    [],
  );

  const activeFile = activeKey ? openFiles[activeKey] ?? null : null;
  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [openFiles, openOrder],
  );
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
    });
  }, [activeFile, dirtyFiles, looseFiles, openFiles, openOrder, roots, setTabCodeWorkspaceContext, tabId, workspace.repoRoot]);

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
                    ) : (
                      <WorkspaceCodeEditor
                        key={activeFile.key}
                        path={activeFile.languagePath}
                        doc={activeFile.text}
                        visible={visible}
                        onChange={(doc) => updateFileText(activeFile.key, doc)}
                        onSave={() => void saveFile(activeFile.key)}
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
  onChange: (doc: string) => void;
  onSave: () => void;
}

function WorkspaceCodeEditor({
  path,
  doc,
  visible,
  onChange,
  onSave,
}: WorkspaceCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

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
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
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

  return <div ref={hostRef} className="h-full w-full" />;
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
