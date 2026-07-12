import { useCallback, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmAppDialog, promptAppDialog } from "../../../lib/appDialogs";
import { writeText } from "../../../lib/clipboard";
import {
  workspaceCreateDir,
  workspaceCreateFile,
  workspaceDeletePath,
  workspaceReadFile,
  workspaceRenamePath,
} from "../../../lib/editor/workspace";
import { selectFilePath, selectFolderPath } from "../../../lib/ipc";
import type {
  CodeWorkspaceFileRef,
  CodeWorkspaceLooseFileInfo,
  CodeWorkspaceRootInfo,
} from "../../../types";
import {
  absoluteWorkspacePath,
  basename,
  errorMessage,
  fileKey,
  fileMeta,
  fileRefUnder,
  joinRelativePath,
  makeLooseFile,
  makeRoot,
  normalizeFsPath,
  parentPath,
  remapFileRef,
  remapRelativePath,
  rootDirKey,
  type DirectoryState,
  type OpenFileState,
  type TreeSelection,
  type TreeViewMode,
} from "./codeWorkspaceModel";

type Updater<T> = T | ((current: T) => T);
type UpdaterSetter<T> = (updater: Updater<T>) => void;
type RootDirectory = { rootId: string; path: string };

interface UseWorkspaceFileActionsOptions {
  roots: CodeWorkspaceRootInfo[];
  selected: TreeSelection | null;
  activeKey: string | null;
  openFiles: Record<string, OpenFileState>;
  directories: Record<string, DirectoryState>;
  expandedRoots: ReadonlySet<string>;
  expandedDirs: ReadonlySet<string>;
  treeViewMode: TreeViewMode;
  rootsRef: RefObject<CodeWorkspaceRootInfo[]>;
  looseFilesRef: RefObject<CodeWorkspaceLooseFileInfo[]>;
  openFilesRef: RefObject<Record<string, OpenFileState>>;
  openOrderRef: RefObject<string[]>;
  setRoots: Dispatch<SetStateAction<CodeWorkspaceRootInfo[]>>;
  setLooseFiles: Dispatch<SetStateAction<CodeWorkspaceLooseFileInfo[]>>;
  setSelected: (selection: TreeSelection | null) => void;
  setExpandedRoots: UpdaterSetter<Set<string>>;
  setExpandedDirs: UpdaterSetter<Set<string>>;
  setOpenFiles: UpdaterSetter<Record<string, OpenFileState>>;
  setOpenOrder: UpdaterSetter<string[]>;
  setActiveKey: UpdaterSetter<string | null>;
  loadDir: (rootId: string, path: string) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  resetTreeData: () => void;
  removeTreeDataRoot: (rootId: string) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean }) => Promise<void>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
  onStatus: (message: string) => void;
}

export interface WorkspaceFileActionsController {
  selectedRootDirectory: RootDirectory | null;
  copyTreePath: (rootId: string, path: string, absolute: boolean) => Promise<void>;
  addRoot: () => Promise<void>;
  addLooseFilePath: (path: string) => Promise<void>;
  openLooseFile: () => Promise<void>;
  refreshTree: () => void;
  toggleRoot: (rootId: string) => void;
  toggleDir: (rootId: string, path: string) => void;
  createFile: (target?: RootDirectory) => Promise<void>;
  createDir: (target?: RootDirectory) => Promise<void>;
  renameSelected: (target?: TreeSelection) => Promise<void>;
  deleteSelected: (target?: TreeSelection) => Promise<void>;
  revealInExplorer: (rootId: string, path: string) => Promise<void>;
  stageTreeClipboard: (mode: "copy" | "cut", rootId: string, path: string) => void;
  canPasteTreeClipboard: () => boolean;
  pasteTreeClipboard: (target: RootDirectory) => Promise<void>;
}

export function useWorkspaceFileActions({
  roots,
  selected,
  activeKey,
  openFiles,
  directories,
  expandedRoots,
  expandedDirs,
  treeViewMode,
  rootsRef,
  looseFilesRef,
  openFilesRef,
  openOrderRef,
  setRoots,
  setLooseFiles,
  setSelected,
  setExpandedRoots,
  setExpandedDirs,
  setOpenFiles,
  setOpenOrder,
  setActiveKey,
  loadDir,
  loadFlatFiles,
  resetTreeData,
  removeTreeDataRoot,
  openFile,
  notifyWorkspacePathGitChanged,
  onStatus,
}: UseWorkspaceFileActionsOptions): WorkspaceFileActionsController {
  const treeClipboardRef = useRef<{ mode: "copy" | "cut"; rootId: string; path: string } | null>(null);
  const findRoot = useCallback(
    (rootId: string) => rootsRef.current?.find((root) => root.id === rootId) ?? null,
    [rootsRef],
  );

  const copyTreePath = useCallback(async (rootId: string, path: string, absolute: boolean) => {
    const root = findRoot(rootId);
    if (!root) return;
    const text = absolute
      ? (path ? `${normalizeFsPath(root.path)}/${path}` : normalizeFsPath(root.path))
      : path || normalizeFsPath(root.path);
    try {
      await writeText(text);
      onStatus(`Copied ${text}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [findRoot, onStatus]);

  const addRoot = useCallback(async () => {
    const path = await selectFolderPath();
    if (!path) return;
    const root = makeRoot(path, "folder");
    if (rootsRef.current?.some((item) => item.path === root.path)) {
      onStatus(`Folder already in workspace: ${root.path}`);
      return;
    }
    setRoots((current) => [...current, root]);
    setExpandedRoots((current) => new Set(current).add(root.id));
    setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, "")));
    onStatus(`Added folder ${root.path}`);
    void loadDir(root.id, "");
  }, [loadDir, onStatus, rootsRef, setExpandedDirs, setExpandedRoots, setRoots]);

  const addLooseFilePath = useCallback(async (path: string) => {
    if (!path) return;
    const file = makeLooseFile(path);
    setLooseFiles((current) => (
      current.some((item) => item.path === file.path) ? current : [...current, file]
    ));
    const ref: CodeWorkspaceFileRef = { kind: "loose", id: file.id, path: file.path };
    setSelected({ kind: "file", ref });
    await openFile(ref);
  }, [openFile, setLooseFiles, setSelected]);

  const openLooseFile = useCallback(async () => {
    const path = await selectFilePath();
    if (!path) return;
    await addLooseFilePath(path);
  }, [addLooseFilePath]);

  const refreshTree = useCallback(() => {
    resetTreeData();
    rootsRef.current?.forEach((root) => {
      if (expandedRoots.has(root.id)) void loadDir(root.id, "");
      if (treeViewMode === "flat") void loadFlatFiles(root.id, true);
    });
  }, [expandedRoots, loadDir, loadFlatFiles, resetTreeData, rootsRef, treeViewMode]);

  const toggleRoot = useCallback((rootId: string) => {
    setSelected({ kind: "root", rootId });
    setExpandedRoots((current) => {
      const next = new Set(current);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
    if (!directories[rootDirKey(rootId, "")]?.loaded) void loadDir(rootId, "");
  }, [directories, loadDir, setExpandedRoots, setSelected]);

  const toggleDir = useCallback((rootId: string, path: string) => {
    const key = rootDirKey(rootId, path);
    const wasExpanded = expandedDirs.has(key);
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    const state = directories[key];
    if (!wasExpanded && (!state?.loaded || state.error)) void loadDir(rootId, path);
  }, [directories, expandedDirs, loadDir, setExpandedDirs]);

  const selectedRootDirectory = useMemo<RootDirectory | null>(() => {
    if (selected?.kind === "dir") return { rootId: selected.rootId, path: selected.path };
    if (selected?.kind === "file" && selected.ref.kind === "root") {
      return { rootId: selected.ref.rootId, path: parentPath(selected.ref.path) };
    }
    if (activeKey) {
      const active = openFiles[activeKey];
      if (active?.ref.kind === "root") {
        return { rootId: active.ref.rootId, path: parentPath(active.ref.path) };
      }
    }
    return roots[0] ? { rootId: roots[0].id, path: "" } : null;
  }, [activeKey, openFiles, roots, selected]);

  const createFile = useCallback(async (target?: RootDirectory) => {
    const directory = target ?? selectedRootDirectory;
    if (!directory) {
      onStatus("Add a folder before creating files");
      return;
    }
    const name = await promptAppDialog({
      title: "New file",
      label: "File name",
      initialValue: directory.path ? `${directory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(directory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(directory.path, name);
    try {
      const file = await workspaceCreateFile(root.path, path);
      await loadDir(root.id, parentPath(file.path));
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: file.path };
      setSelected({ kind: "file", ref });
      await openFile(ref);
      notifyWorkspacePathGitChanged(root.id, file.path);
      onStatus(`Created ${root.name} / ${file.path}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, onStatus, openFile, selectedRootDirectory, setSelected]);

  const createDir = useCallback(async (target?: RootDirectory) => {
    const directory = target ?? selectedRootDirectory;
    if (!directory) {
      onStatus("Add a folder before creating directories");
      return;
    }
    const name = await promptAppDialog({
      title: "New directory",
      label: "Directory name",
      initialValue: directory.path ? `${directory.path}/` : "",
    });
    if (!name) return;
    const root = findRoot(directory.rootId);
    if (!root) return;
    const path = name.includes("/") || name.includes("\\")
      ? name.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : joinRelativePath(directory.path, name);
    try {
      const entry = await workspaceCreateDir(root.path, path);
      await loadDir(root.id, parentPath(entry.path));
      setExpandedDirs((current) => new Set(current).add(rootDirKey(root.id, parentPath(entry.path))));
      setSelected({ kind: "dir", rootId: root.id, path: entry.path });
      notifyWorkspacePathGitChanged(root.id, entry.path);
      onStatus(`Created ${root.name} / ${entry.path}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, onStatus, selectedRootDirectory, setExpandedDirs, setSelected]);

  const renameSelected = useCallback(async (target?: TreeSelection) => {
    const selection = target ?? selected;
    if (!selection) return;
    if (selection.kind === "root") {
      const root = findRoot(selection.rootId);
      if (!root) return;
      const name = await promptAppDialog({
        title: "Rename root",
        label: "Display name",
        initialValue: root.name,
      });
      if (!name || name === root.name) return;
      setRoots((current) => current.map((item) => item.id === root.id ? { ...item, name } : item));
      return;
    }
    if (selection.kind === "file" && selection.ref.kind === "loose") {
      const ref = selection.ref;
      const loose = looseFilesRef.current?.find((item) => item.id === ref.id);
      if (!loose) return;
      const name = await promptAppDialog({
        title: "Rename loose file",
        label: "Display name",
        initialValue: loose.name,
      });
      if (!name || name === loose.name) return;
      setLooseFiles((current) => current.map((item) => item.id === loose.id ? { ...item, name } : item));
      return;
    }
    const rootTarget = selection.kind === "dir"
      ? { rootId: selection.rootId, path: selection.path }
      : selection.ref.kind === "root"
        ? { rootId: selection.ref.rootId, path: selection.ref.path }
        : null;
    if (!rootTarget) return;
    const root = findRoot(rootTarget.rootId);
    if (!root) return;
    const nextName = await promptAppDialog({
      title: "Rename",
      label: "New name",
      initialValue: basename(rootTarget.path),
    });
    if (!nextName || nextName === basename(rootTarget.path)) return;
    const nextPath = joinRelativePath(parentPath(rootTarget.path), nextName);
    try {
      const entry = await workspaceRenamePath(root.path, rootTarget.path, nextPath);
      const newPath = entry.path;
      await loadDir(root.id, parentPath(rootTarget.path));
      await loadDir(root.id, parentPath(newPath));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          next.add(id === root.id
            ? rootDirKey(root.id, remapRelativePath(path, rootTarget.path, newPath))
            : item);
        }
        return next;
      });
      const currentOpenFiles = openFilesRef.current ?? {};
      const remappedKeys = new Map<string, string>();
      const remappedOpenFiles: Record<string, OpenFileState> = {};
      for (const [currentKey, file] of Object.entries(currentOpenFiles)) {
          const ref = remapFileRef(file.ref, root.id, rootTarget.path, newPath);
          const meta = fileMeta(ref, rootsRef.current ?? [], looseFilesRef.current ?? []);
          const nextKey = fileKey(ref);
          remappedKeys.set(currentKey, nextKey);
          remappedOpenFiles[nextKey] = {
            ...file,
            ref,
            key: nextKey,
            path: meta.path,
            title: meta.title,
            subtitle: meta.subtitle,
            languagePath: meta.languagePath,
          };
      }
      setOpenFiles(remappedOpenFiles);
      setOpenOrder((current) => current.map((key) => remappedKeys.get(key) ?? key));
      setActiveKey((current) => current ? remappedKeys.get(current) ?? current : null);
      setSelected(entry.fileType === "dir"
        ? { kind: "dir", rootId: root.id, path: newPath }
        : { kind: "file", ref: { kind: "root", rootId: root.id, path: newPath } });
      notifyWorkspacePathGitChanged(root.id, rootTarget.path);
      notifyWorkspacePathGitChanged(root.id, newPath);
      onStatus(`Renamed to ${root.name} / ${newPath}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [
    findRoot,
    loadDir,
    looseFilesRef,
    notifyWorkspacePathGitChanged,
    onStatus,
    openFilesRef,
    rootsRef,
    selected,
    setActiveKey,
    setExpandedDirs,
    setLooseFiles,
    setOpenFiles,
    setOpenOrder,
    setRoots,
    setSelected,
  ]);

  const deleteSelected = useCallback(async (target?: TreeSelection) => {
    const selection = target ?? selected;
    if (!selection) return;
    if (selection.kind === "root") {
      const root = findRoot(selection.rootId);
      if (!root) return;
      const confirmed = await confirmAppDialog({
        title: "Remove folder",
        message: `Remove ${root.name} from this workspace? Files on disk are not deleted.`,
        confirmLabel: "Remove",
      });
      if (!confirmed) return;
      const removedKeys = new Set(Object.entries(openFilesRef.current ?? {})
        .filter(([, file]) => file.ref.kind === "root" && file.ref.rootId === root.id)
        .map(([key]) => key));
      const remaining = (openOrderRef.current ?? []).filter((key) => !removedKeys.has(key));
      setRoots((current) => current.filter((item) => item.id !== root.id));
      removeTreeDataRoot(root.id);
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => (
        file.ref.kind !== "root" || file.ref.rootId !== root.id
      ))));
      setOpenOrder(remaining);
      setActiveKey((current) => current && !remaining.includes(current) ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    if (selection.kind === "file" && selection.ref.kind === "loose") {
      const ref = selection.ref;
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
      const remaining = (openOrderRef.current ?? []).filter((item) => item !== key);
      setOpenOrder(remaining);
      setActiveKey((current) => current === key ? remaining[0] ?? null : current);
      setSelected(null);
      return;
    }
    const rootTarget = selection.kind === "dir"
      ? { rootId: selection.rootId, path: selection.path }
      : selection.ref.kind === "root"
        ? { rootId: selection.ref.rootId, path: selection.ref.path }
        : null;
    if (!rootTarget) return;
    const root = findRoot(rootTarget.rootId);
    if (!root) return;
    const confirmed = await confirmAppDialog({
      title: "Delete",
      message: `Delete ${root.name} / ${rootTarget.path}?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await workspaceDeletePath(root.path, rootTarget.path, selection.kind === "dir");
      await loadDir(root.id, parentPath(rootTarget.path));
      const removedKeys = new Set(Object.entries(openFilesRef.current ?? {})
        .filter(([, file]) => fileRefUnder(file.ref, root.id, rootTarget.path))
        .map(([key]) => key));
      const remainingOpen = (openOrderRef.current ?? []).filter((key) => !removedKeys.has(key));
      setExpandedDirs((current) => {
        const next = new Set<string>();
        for (const item of current) {
          const [id, path] = item.split(":", 2);
          if (id !== root.id || (path !== rootTarget.path && !path.startsWith(`${rootTarget.path}/`))) {
            next.add(item);
          }
        }
        return next;
      });
      setOpenFiles((current) => Object.fromEntries(Object.entries(current).filter(([, file]) => (
        !fileRefUnder(file.ref, root.id, rootTarget.path)
      ))));
      setOpenOrder(remainingOpen);
      setActiveKey((current) => {
        return current && removedKeys.has(current) ? remainingOpen[0] ?? null : current;
      });
      setSelected(null);
      notifyWorkspacePathGitChanged(root.id, rootTarget.path);
      onStatus(`Deleted ${root.name} / ${rootTarget.path}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [
    findRoot,
    loadDir,
    notifyWorkspacePathGitChanged,
    onStatus,
    openFilesRef,
    openOrderRef,
    removeTreeDataRoot,
    selected,
    setActiveKey,
    setExpandedDirs,
    setLooseFiles,
    setOpenFiles,
    setOpenOrder,
    setRoots,
    setSelected,
  ]);

  const revealInExplorer = useCallback(async (rootId: string, path: string) => {
    const root = findRoot(rootId);
    if (!root) return;
    const absolute = path ? absoluteWorkspacePath(root, path) : normalizeFsPath(root.path);
    try {
      await invoke("sftp_open_path", { path: absolute });
      onStatus(`Opened ${absolute}`);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [findRoot, onStatus]);

  const stageTreeClipboard = useCallback((mode: "copy" | "cut", rootId: string, path: string) => {
    treeClipboardRef.current = { mode, rootId, path };
    onStatus(mode === "cut" ? "Cut to clipboard" : "Copied to clipboard");
  }, [onStatus]);

  const canPasteTreeClipboard = useCallback(() => treeClipboardRef.current !== null, []);

  const pasteTreeClipboard = useCallback(async (target: RootDirectory) => {
    const clip = treeClipboardRef.current;
    if (!clip) {
      onStatus("Nothing to paste");
      return;
    }
    if (clip.rootId !== target.rootId) {
      onStatus("Cross-root paste is not supported");
      return;
    }
    const root = findRoot(clip.rootId);
    if (!root) return;
    const name = basename(clip.path);
    const destPath = target.path ? `${target.path}/${name}` : name;
    try {
      if (clip.mode === "cut") {
        await workspaceRenamePath(root.path, clip.path, destPath);
        treeClipboardRef.current = null;
        onStatus(`Moved to ${destPath}`);
      } else {
        const file = await workspaceReadFile(root.path, clip.path);
        await workspaceCreateFile(root.path, destPath, file.text);
        onStatus(`Copied to ${destPath}`);
      }
      await loadDir(clip.rootId, parentPath(clip.path) || "");
      await loadDir(target.rootId, target.path);
      notifyWorkspacePathGitChanged(target.rootId, destPath);
    } catch (error) {
      onStatus(errorMessage(error));
    }
  }, [findRoot, loadDir, notifyWorkspacePathGitChanged, onStatus]);

  return {
    selectedRootDirectory,
    copyTreePath,
    addRoot,
    addLooseFilePath,
    openLooseFile,
    refreshTree,
    toggleRoot,
    toggleDir,
    createFile,
    createDir,
    renameSelected,
    deleteSelected,
    revealInExplorer,
    stageTreeClipboard,
    canPasteTreeClipboard,
    pasteTreeClipboard,
  };
}
