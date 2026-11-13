import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sftpLocalHome, formatBytes } from "../../lib/sftp";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { getAppPlatform } from "../../lib/runtime";
import { useSftpStore } from "../../stores/sftpStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { LocalFileBrowserPanel } from "../filebrowser/LocalFileBrowserPanel";
import { ExplorerAddressBar } from "./ExplorerAddressBar";
import { ExplorerCommandBar } from "./ExplorerCommandBar";
import { ExplorerNavTree } from "./ExplorerNavTree";
import { ExplorerFileList } from "./ExplorerFileList";
import { ExplorerStatusBar } from "./ExplorerStatusBar";
import { ExplorerDialogs } from "./ExplorerDialogs";
import { ExplorerContext } from "./ExplorerContext";
import { ExplorerPreviewPane } from "./preview/ExplorerPreviewPane";
import { explorerEmptyMenu, explorerItemMenu } from "./explorerContextMenus";
import { setExplorerPreferences, useExplorerPreferences } from "./explorerPreferences";
import { useExplorerOperations } from "./useExplorerOperations";
import { useExplorerDirectory } from "./useExplorerDirectory";
import { useExplorerDrop } from "./useExplorerDrop";
import { useExplorerLabels } from "./explorerLabels";
import "./explorer.css";

export interface ExplorerShellProps {
  tabId: string;
  initialPath: string;
  workspaceId?: string;
  active?: boolean;
  onOpenTerminal?: (path: string) => void;
}

/** Composition only: directory, filesystem work, preview and navigation have independent owners. */
export function ExplorerShell({ tabId, initialPath, workspaceId, active = true, onOpenTerminal }: ExplorerShellProps) {
  const label = useExplorerLabels();
  const preferences = useExplorerPreferences();
  const operations = useExplorerOperations(tabId, workspaceId);
  const pane = useExplorerDirectory(tabId, initialPath, operations.notify);
  const [home, setHome] = useState("");
  const [filter, setFilter] = useState("");
  const [width, setWidth] = useState(1200);
  const [previewOverlay, setPreviewOverlay] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const dropPath = useExplorerDrop(root, operations);
  useEffect(() => {
    let disposed = false;
    void sftpLocalHome().then((value) => { if (!disposed) setHome(value); }).catch((error) => operations.notify(String(error), true));
    const element = root.current;
    const observer = new ResizeObserver(() => { if (element) setWidth(element.clientWidth); });
    if (element) { observer.observe(element); setWidth(element.clientWidth); }
    return () => { disposed = true; observer.disconnect(); resizeCleanup.current?.(); };
  }, [operations.notify]);
  useEffect(() => { setFilter(""); setPreviewOverlay(false); }, [pane?.path]);
  useEffect(() => {
    if (!pane) return;
    if (pane.showHidden !== preferences.showHidden) useSftpStore.getState().toggleHidden(tabId, "local");
  }, [tabId, pane?.showHidden, preferences.showHidden]);
  const visible = useMemo(() => pane?.entries.filter((entry) => (preferences.showHidden || !entry.isHidden) && entry.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? [], [pane?.entries, preferences.showHidden, filter]);
  const selected = useMemo(() => {
    const paths = new Set(pane?.selection ?? []);
    return visible.filter((entry) => paths.has(entry.path));
  }, [pane?.selection, visible]);
  const narrow = width < preferences.navWidth + preferences.previewWidth + 380;
  const previewVisible = preferences.preview && (!narrow || previewOverlay);
  const togglePreview = useCallback(() => {
    if (narrow && preferences.preview) { setPreviewOverlay((old) => !old); return; }
    setExplorerPreferences({ preview: !preferences.preview });
    if (narrow) setPreviewOverlay(true);
  }, [narrow, preferences.preview]);
  const closePreview = () => { setExplorerPreferences({ preview: false }); setPreviewOverlay(false); };
  const openExplorerAt = useCallback((path: string, forceNew = false) => {
    void openExplorer(path, { workspaceId, forceNew }).catch((error) => operations.notify(String(error), true));
  }, [workspaceId, operations.notify]);
  const terminal = useCallback((path: string) => {
    if (onOpenTerminal) onOpenTerminal(path);
    else if (workspaceId) useWorkspacePlatformStore.getState().openLocalTerminalInWorkspace(workspaceId, path);
    else operations.notify(label("终端入口暂不可用", "Terminal entry is unavailable"), true);
  }, [workspaceId, onOpenTerminal, operations.notify, label]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || operations.deletePrompt || operations.properties) return;
    const target = event.target as HTMLElement;
    const editable = !!target.closest("input,textarea,select,[contenteditable=true]");
    const mac = getAppPlatform() === "macos";
    const mod = mac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const editChord = mod && !event.shiftKey && !event.altKey && !(mac ? event.ctrlKey : event.metaKey);
    if (editChord && key === "l") {
      event.preventDefault(); event.stopPropagation(); address.current?.focus(); address.current?.select(); return;
    }
    if (editable) return;
    const store = useSftpStore.getState();
    let handled = true;
    if (editChord && key === "c") void operations.copy(selected, false);
    else if (editChord && key === "x") void operations.copy(selected, true);
    else if (editChord && key === "v") void operations.paste();
    else if (editChord && key === "a") store.setSelection(tabId, "local", visible.map((entry) => entry.path));
    else if (mod && event.shiftKey && key === "n") void operations.create(true);
    else if (event.key === "F2" && selected.length === 1) operations.setRenamePath(selected[0].path);
    else if ((event.key === "Delete" || (mac && event.metaKey && event.key === "Backspace")) && !operations.busy) operations.remove(selected, event.shiftKey);
    else if (event.key === "F5") void store.refreshPane(tabId, "local");
    else if (event.altKey && !mod && !event.shiftKey && (key === "p" || (mac && event.code === "KeyP"))) togglePreview();
    else if (event.altKey && event.key === "ArrowLeft") void store.navigateBack(tabId, "local");
    else if (event.altKey && event.key === "ArrowRight") void store.navigateForward(tabId, "local");
    else if ((event.altKey && event.key === "ArrowUp") || event.key === "Backspace") void store.navigateUp(tabId, "local");
    else if (event.altKey && event.key === "Enter" && selected.length) operations.setProperties(selected);
    else if (event.key === "Enter" && selected.length === 1) void operations.open(selected[0], mod);
    else if (event.key === "Escape") { operations.setRenamePath(null); setPreviewOverlay(false); }
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  };
  const resize = (event: React.PointerEvent, kind: "nav" | "preview") => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const origin = event.clientX;
    const start = kind === "nav" ? preferences.navWidth : preferences.previewWidth;
    const move = (next: PointerEvent) => {
      const delta = next.clientX - origin;
      setExplorerPreferences(kind === "nav" ? { navWidth: Math.max(140, Math.min(380, start + delta)) } : { previewWidth: Math.max(220, Math.min(600, start - delta)) });
    };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", cleanup); window.removeEventListener("pointercancel", cleanup); resizeCleanup.current = null; };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", cleanup); window.addEventListener("pointercancel", cleanup);
  };
  const preview = previewVisible ? <ExplorerPreviewPane entries={selected} currentPath={pane?.path ?? initialPath} tabId={tabId} workspaceId={workspaceId} onOpen={(entry) => void operations.open(entry)} onClose={closePreview} /> : null;
  const viewContext = { operations, dropPath, onOpenExplorer: openExplorerAt, onOpenTerminal: terminal, onProperties: () => operations.setProperties(selected) };
  return <ExplorerContext.Provider value={viewContext}>
    <div ref={root} className="ex-shell" data-testid="explorer-tab" data-tab-id={tabId} data-path={pane?.path ?? initialPath} data-active={active}
      data-preview-collapsed={preferences.preview && narrow && !previewOverlay ? "true" : "false"} tabIndex={0} onKeyDown={onKeyDown}>
      <ExplorerAddressBar tabId={tabId} pane={pane} home={home} filter={filter} onFilter={setFilter} addressRef={address} />
      <ExplorerCommandBar path={pane?.path ?? ""} workspaceId={workspaceId} selected={selected} operations={operations} onOpenTerminal={terminal} onOpenExplorer={openExplorerAt} previewVisible={previewVisible} onTogglePreview={togglePreview} />
      <div className="ex-body">
        <ExplorerNavTree home={home} path={pane?.path ?? initialPath} dropPath={dropPath} onNavigate={(path) => void useSftpStore.getState().navigate(tabId, "local", path)} onOpenExplorer={openExplorerAt} onOpenTerminal={terminal} />
        <div className="ex-split" role="separator" aria-orientation="vertical" aria-label={label("调整导航宽度", "Resize navigation")} onPointerDown={(event) => resize(event, "nav")} />
        <div className={`ex-main ${preferences.previewPosition === "bottom" && !narrow ? "bottom" : ""}`}>
          <LocalFileBrowserPanel tabId={tabId} initialPath={initialPath} explorer={{
            renderView: ExplorerFileList,
            sortState: { key: preferences.sortKey, dir: preferences.sortDir, onChange: (sortKey, sortDir) => setExplorerPreferences({ sortKey, sortDir }) },
            filterText: filter, onFilterTextChange: setFilter,
            onItemDoubleClick: (entry) => void operations.open(entry),
            onItemContext: (entry, _anchor, selection) => explorerItemMenu(selection.length ? selection : [entry], pane?.path ?? initialPath, operations, label, openExplorerAt, terminal, workspaceId),
            onEmptyContext: () => explorerEmptyMenu(pane?.path ?? initialPath, operations, label, () => void useSftpStore.getState().refreshPane(tabId, "local")),
          }} />
          {previewVisible && !narrow && preferences.previewPosition === "right" && <div className="ex-split" role="separator" aria-orientation="vertical" aria-label={label("调整预览宽度", "Resize preview")} onPointerDown={(event) => resize(event, "preview")} />}
          {narrow && previewOverlay ? <div className="ex-preview-overlay" data-position={preferences.previewPosition}>{preview}</div> : preview}
        </div>
      </div>
      <ExplorerStatusBar entries={visible} selected={selected} />
      {operations.busy && <div className="ex-toast" role="status" data-testid="explorer-progress"><span>{operations.progress ? `${operations.progress.items} ${label("项", "items")} · ${formatBytes(operations.progress.bytes)}` : label("正在处理…", "Working…")}</span><button onClick={operations.cancel}>{label("取消", "Cancel")}</button></div>}
      {operations.toast && <div className={`ex-toast ${operations.toast.error ? "error" : ""}`} role="status" data-testid="explorer-toast"><span>{operations.toast.message}</span>{operations.toast.undo && <button data-testid="explorer-undo" onClick={operations.toast.undo}>{label("撤销", "Undo")}</button>}</div>}
      <ExplorerDialogs operations={operations} />
    </div>
  </ExplorerContext.Provider>;
}
