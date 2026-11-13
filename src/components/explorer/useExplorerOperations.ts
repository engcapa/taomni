import { useCallback, useEffect, useRef, useState } from "react";
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
import { openFile } from "../../lib/openFile";

export interface ExplorerToast { message: string; error?: boolean; undo?: () => void }
export interface DeletePrompt { entries: FileEntry[]; reason?: string }
export function useExplorerOperations(tabId: string, workspaceId?: string) {
  const label = useExplorerLabels();
  const [toast, setToast] = useState<ExplorerToast | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null);
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [properties, setProperties] = useState<FileEntry[] | null>(null);
  const [progress, setProgress] = useState<ExplorerProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const notify = useCallback((message: string, error = false) => {
    if (mounted.current) setToast({ message, error });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.undo ? 10000 : toast.error ? 12000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
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
  const run = useCallback(async (task: (id: string) => Promise<void>) => {
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
    try { await task(id); } catch (error) { notify(String(error), true); }
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
      try { await openFile({ path: entry.path }, { context: "explorer", workspaceId, alternate }); } catch (error) { notify(String(error), true); }
    }
  }, [notify, tabId, workspaceId]);
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
    // Decide each source independently: cross-device drops copy, explicit cut still moves.
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
  const remove = useCallback((entries: FileEntry[], permanent = false) => {
    if (!entries.length) return;
    if (permanent) { setDeletePrompt({ entries }); return; }
    void run(async () => {
      const result = await localTrashEntries(entries.map((entry) => entry.path));
      await refreshAll();
      if (result.failed.length) {
        const failedPaths = new Set(result.failed.map((failure) => failure.path));
        setDeletePrompt({ entries: entries.filter((entry) => failedPaths.has(entry.path)), reason: result.failed.map((failure) => `${failure.path}: ${failure.message}`).join("\n") });
      }
      if (result.trashed.length) {
        const items: TrashRef[] = result.trashed;
        setToast({ message: label(`已将 ${items.length} 项移到回收站`, `Moved ${items.length} item(s) to Trash`), undo: () => {
          void run(async () => {
            setToast(null);
            const restored = await localTrashRestore(items);
            await refreshAll(); summarize(restored.done.length, restored.failed);
          });
        } });
      }
    });
  }, [label, refreshAll, run, summarize]);
  const rename = useCallback(async (entry: FileEntry, name: string): Promise<boolean> => {
    if (entry.name === name) { setRenamePath(null); return true; }
    try {
      const path = await localRenameEntry(entry.path, name);
      await refreshAll();
      useSftpStore.getState().setSelection(tabId, "local", [path]);
      setRenamePath(null);
      return true;
    } catch (error) { notify(String(error), true); return false; }
  }, [notify, refreshAll, tabId]);
  const create = useCallback((directory: boolean) => run(async () => {
    const pane = useSftpStore.getState().sessions[tabId]?.local;
    if (!pane) return;
    const base = directory ? label("新建文件夹", "New folder") : label("新建文本文档", "New text document");
    const extension = directory ? "" : ".txt";
    const existing = new Set(pane.entries.map((entry) => entry.name));
    let name = `${base}${extension}`;
    let i = 2;
    while (existing.has(name)) name = `${base} (${i++})${extension}`;
    const path = await localCreateEntry(pane.path, name, directory);
    await refreshAll();
    useSftpStore.getState().setSelection(tabId, "local", [path]);
    setRenamePath(path);
  }), [label, refreshAll, run, tabId]);
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
  return { toast, notify, busy, progress, cancel, open, copy, paste, drop, transfer, remove, permanentDelete,
    rename, renamePath, setRenamePath, create, copyPath, reveal, deletePrompt, setDeletePrompt, properties, setProperties };
}

export type ExplorerOperations = ReturnType<typeof useExplorerOperations>;
