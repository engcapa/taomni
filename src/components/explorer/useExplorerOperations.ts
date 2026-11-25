import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { readFilesResult, writeText } from "../../lib/clipboard";
import { notifyClipboardWritten } from "../../lib/clipboardOwnership";
import {
  explorerCancelOperation, explorerSameVolume, explorerWriteClipboardFiles, explorerUpdateCutClipboard, localCopyEntries, localMoveEntries,
  localTrashEntries, localTrashRestore, localRenameEntry, localCreateEntry,
  type EntryOperationResult, type ExplorerProgress, type OperationFailure, type TrashRef,
} from "../../lib/explorer";
import { effectiveFileType, sftpOpenPath, sftpRemove, type FileEntry } from "../../lib/sftp";
import { useSftpStore } from "../../stores/sftpStore";
import { clipboardMatches, getExplorerClipboard, setExplorerClipboard } from "./explorerClipboard";
import { useExplorerLabels } from "./explorerLabels";
import { openFile, UnavailableFileHandlerError } from "../../lib/openFile";
import { EXPLORER_TEXT_FILE_TYPES, newFileNameError, uniqueNewFileName, type ExplorerQuickExtension } from "./explorerFileTypes";
import { useToastQueue } from "../ui/Toast";
import { setExplorerPreferences } from "./explorerPreferences";

export interface DeletePrompt { entries: FileEntry[]; reason?: string; defaultIntent?: "trash" | "permanent" }
export interface UnavailableHandlerPrompt { path: string; handlerLabel: string; message: string }
export function useExplorerOperations(tabId: string, workspaceId?: string) {
  const label = useExplorerLabels();
  const { entries: toasts, publish, dismiss } = useToastQueue();
  const [newFileError, setNewFileError] = useState("");
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null);
  const [unavailablePrompt, setUnavailablePrompt] = useState<UnavailableHandlerPrompt | null>(null);
  const [renamePath, updateRenamePath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState("");
  const renameErrorId = useId();
  const renameOwner = useRef(0);
  const setRenamePath = useCallback((path: string | null) => {
    renameOwner.current++;
    setRenameError("");
    updateRenamePath(path);
  }, []);
  const [properties, setProperties] = useState<FileEntry[] | null>(null);
  const [progress, setProgress] = useState<ExplorerProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const notify = useCallback((message: string, error = false, rawError?: unknown) => {
    if (!mounted.current) return;
    if (rawError instanceof UnavailableFileHandlerError) {
      setUnavailablePrompt({ path: rawError.filePath, handlerLabel: rawError.handlerLabel, message });
      return;
    }
    publish({ message, error });
  }, [publish]);
  const refreshAll = useCallback(async () => {
    const store = useSftpStore.getState();
    await Promise.all(Object.keys(store.sessions).filter((id) => store.sessions[id].local.path && !store.sessions[id].local.loading)
      .map((id) => store.refreshPane(id, "local")));
  }, []);
  const summarize = useCallback((done: number, failed: OperationFailure[]) => {
    notify([
      label(`已完成 ${done} 项`, `Completed ${done} item(s)`),
      ...failed.map((failure) => `${failure.path}: ${failure.message}`),
    ].join("\n"), failed.length > 0);
  }, [label, notify]);
  const run = useCallback(async (task: (id: string) => Promise<void>, reportError?: (reason: string) => void) => {
    if (lock.current) return;
    lock.current = true;
    cancelled.current = false;
    const id = `explorer-${crypto.randomUUID()}`;
    operation.current = id;
    setBusy(true);
    let disposed = false;
    const listening = listen<ExplorerProgress>("explorer:progress", ({ payload }) => {
      if (!disposed && mounted.current && payload.operationId === id) setProgress(payload);
    }).catch(() => () => {});
    try { await task(id); } catch (error) {
      if (reportError) reportError(String(error));
      else notify(String(error), true, error);
    }
    finally {
      disposed = true;
      void listening.then((unlisten) => unlisten());
      lock.current = false;
      operation.current = null;
      if (mounted.current) { setBusy(false); setProgress(null); }
    }
  }, [notify]);
  const open = useCallback(async (entry: FileEntry, alternate = false) => {
    if (effectiveFileType(entry) === "dir") await useSftpStore.getState().navigate(tabId, "local", entry.path);
    else {
      try { await openFile({ path: entry.path }, { context: "explorer", workspaceId, alternate }); } catch (error) { notify(String(error), true, error); }
    }
  }, [notify, tabId, workspaceId]);
  const openWithSystemFallback = useCallback(async (path: string) => {
    setUnavailablePrompt(null);
    try { await sftpOpenPath(path); } catch (error) { notify(String(error), true); }
  }, [notify]);
  const copy = useCallback(async (entries: FileEntry[], cut: boolean) => {
    if (!entries.length) return;
    const paths = entries.map((entry) => entry.path);
    try {
      await explorerWriteClipboardFiles(paths, cut);
      notifyClipboardWritten();
      setExplorerClipboard({ paths, cut });
      notify(label(`${cut ? "已剪切" : "已复制"} ${paths.length} 项到剪贴板`, `${cut ? "Cut" : "Copied"} ${paths.length} item(s) to clipboard`));
    } catch (error) { notify(String(error), true); }
  }, [notify, label]);
  const transfer = useCallback((paths: string[], destination: string, move: boolean) => run(async (id) => {
    const result = await (move ? localMoveEntries : localCopyEntries)(paths, destination, id);
    await refreshAll();
    summarize(result.done.length, result.failed);
  }), [refreshAll, run, summarize]);
  const paste = useCallback(() => run(async (id) => {
    const system = await readFilesResult();
    if (!system.ok) throw new Error(system.message);
    if (!system.paths.length) { setExplorerClipboard(null); notify(label("剪贴板中没有文件", "No files in clipboard")); return; }
    const clipboard = getExplorerClipboard();
    const cut = clipboardMatches(system.paths, clipboard) && !!clipboard?.cut;
    if (!clipboardMatches(system.paths, clipboard)) setExplorerClipboard(null);
    const path = useSftpStore.getState().sessions[tabId]?.local.path;
    if (!path) return;
    const result = await (cut ? localMoveEntries : localCopyEntries)(system.paths, path, id);
    if (cut) {
      const succeeded = new Set(result.done.map((item) => item.from));
      const remaining = system.paths.filter((value) => !succeeded.has(value));
      try {
        const retained = await explorerUpdateCutClipboard(system.paths, remaining);
        setExplorerClipboard(retained && remaining.length ? { paths: remaining, cut: true } : null);
      } catch (error) {
        setExplorerClipboard(null);
        result.failed.push({ path: label("系统剪贴板", "System clipboard"), code: "clipboard_update_failed", message: String(error) });
      }
    }
    await refreshAll();
    summarize(result.done.length, result.failed);
  }), [notify, label, refreshAll, run, summarize, tabId]);
  const drop = useCallback((paths: string[], destination: string, forceCopy: boolean) => run(async (id) => {
    const result: EntryOperationResult = { done: [], failed: [] };
    for (const path of paths) {
      if (cancelled.current) { result.failed.push({ path, code: "cancelled", message: label("操作已取消，已完成的项目保留", "Cancelled; completed items were retained") }); continue; }
      try {
        const move = !forceCopy && await explorerSameVolume(path, destination);
        if (cancelled.current) { result.failed.push({ path, code: "cancelled", message: label("操作已取消", "Cancelled") }); continue; }
        const next = await (move ? localMoveEntries : localCopyEntries)([path], destination, id);
        result.done.push(...next.done); result.failed.push(...next.failed);
      } catch (error) { result.failed.push({ path, code: "drop_failed", message: String(error) }); }
    }
    await refreshAll();
    summarize(result.done.length, result.failed);
  }), [label, refreshAll, run, summarize]);
  const permanentDelete = useCallback((entries: FileEntry[]) => run(async () => {
    setDeletePrompt(null);
    const failures: OperationFailure[] = [];
    let done = 0;
    for (const entry of entries) {
      try { await sftpRemove(tabId, entry.path, "local", true); done++; }
      catch (error) { failures.push({ path: entry.path, code: "remove_failed", message: String(error) }); }
    }
    await refreshAll(); summarize(done, failures);
  }), [refreshAll, run, summarize, tabId]);
  /** Del/Shift+Del and every menu entry first ask whether to use Trash or delete for good. */
  const remove = useCallback((entries: FileEntry[], permanent = false) => {
    if (!entries.length) return;
    setDeletePrompt({ entries, defaultIntent: permanent ? "permanent" : "trash" });
  }, []);
  /** Confirmed Trash choice. Only failed items fall back to an explicit permanent prompt. */
  const trash = useCallback((entries: FileEntry[]) => {
    if (!entries.length) return;
    setDeletePrompt(null);
    void run(async () => {
      const result = await localTrashEntries(entries.map((entry) => entry.path));
      await refreshAll();
      if (result.failed.length) {
        const failedPaths = new Set(result.failed.map((failure) => failure.path));
        setDeletePrompt({
          entries: entries.filter((entry) => failedPaths.has(entry.path)),
          reason: result.failed.map((failure) => `${failure.path}: ${failure.message}`).join("\n"),
          defaultIntent: "permanent",
        });
      }
      if (result.trashed.length) {
        const items: TrashRef[] = result.trashed;
        publish({
          message: label(`已将 ${items.length} 项移到回收站`, `Moved ${items.length} item(s) to Trash`),
          action: {
            label: label("撤销", "Undo"),
            testId: "explorer-undo",
            run: () => void run(async () => {
              const restored = await localTrashRestore(items);
              await refreshAll();
              summarize(restored.done.length, restored.failed);
            }),
          },
        });
      }
    });
  }, [label, publish, refreshAll, run, summarize]);
  const rename = useCallback(async (entry: FileEntry, name: string): Promise<boolean> => {
    const owner = renameOwner.current;
    if (entry.name === name) { setRenamePath(null); return true; }
    setRenameError("");
    try {
      const path = await localRenameEntry(entry.path, name);
      await refreshAll();
      if (owner === renameOwner.current && mounted.current) {
        useSftpStore.getState().setSelection(tabId, "local", [path]);
        setRenamePath(null);
      }
      return true;
    } catch (error) {
      if (owner === renameOwner.current && mounted.current) setRenameError(String(error));
      return false;
    }
  }, [refreshAll, setRenamePath, tabId]);
  const suggestFileName = useCallback((name: string) => uniqueNewFileName(name,
    useSftpStore.getState().sessions[tabId]?.local.entries.map((entry) => entry.name) ?? []), [tabId]);
  const createEntry = useCallback(async (name: string, directory: boolean) => {
    const pane = useSftpStore.getState().sessions[tabId]?.local;
    if (!pane) throw new Error(label("目录不可用", "Folder is unavailable"));
    const path = await localCreateEntry(pane.path, name, directory);
    if (name.startsWith(".")) setExplorerPreferences({ showHidden: true });
    await refreshAll();
    useSftpStore.getState().setSelection(tabId, "local", [path]);
    setRenamePath(path);
  }, [label, refreshAll, setRenamePath, tabId]);
  const create = useCallback((directory: boolean, extension: ExplorerQuickExtension = "txt") => run(async () => {
    const fileType = EXPLORER_TEXT_FILE_TYPES.find((type) => type.extension === extension)!;
    const name = directory ? label("新建文件夹", "New folder") : `${label(fileType.name[0], fileType.name[1])}.${extension}`;
    await createEntry(suggestFileName(name), directory);
  }), [createEntry, label, run, suggestFileName]);
  const createFile = useCallback(async (name: string) => {
    let created = false;
    await run(async () => {
      setNewFileError("");
      const error = newFileNameError(name, label);
      if (error) throw new Error(error);
      const entries = useSftpStore.getState().sessions[tabId]?.local.entries ?? [];
      if (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(label("该文件已存在，请选择其他名称", "This file already exists; choose another name"));
      }
      await createEntry(name, false);
      setNewFile(false);
      created = true;
    }, setNewFileError);
    return created;
  }, [createEntry, label, run, tabId]);
  const startNewFile = useCallback(() => { setNewFileError(""); setNewFile(true); }, []);
  const copyPath = useCallback(async (paths: string[]) => {
    try { await writeText(paths.join("\n")); notify(label("已复制路径", "Path copied")); }
    catch (error) { notify(String(error), true); }
  }, [label, notify]);
  const reveal = useCallback(async (path: string) => {
    try { await sftpOpenPath(path); } catch (error) { notify(String(error), true); }
  }, [notify]);
  const cancel = useCallback(() => {
    cancelled.current = true;
    if (operation.current) void explorerCancelOperation(operation.current).catch((error) => notify(String(error), true));
  }, [notify]);
  return { toasts, dismiss, newFileError, notify, busy, progress, cancel, open, openWithSystemFallback, copy, paste, drop, transfer, remove, trash, permanentDelete,
    rename, renamePath, setRenamePath, renameError, renameErrorId, create, createFile, suggestFileName, newFile, setNewFile, startNewFile,
    copyPath, reveal, deletePrompt, setDeletePrompt, unavailablePrompt, setUnavailablePrompt, properties, setProperties };
}

export type ExplorerOperations = ReturnType<typeof useExplorerOperations>;
