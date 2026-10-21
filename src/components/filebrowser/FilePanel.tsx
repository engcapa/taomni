import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCustomDropTarget, type CustomDragData } from "../../lib/customDnD";
import { useT } from "../../lib/i18n";
import { NATIVE_FILE_DROP_EVENT, type NativeFileDropDetail } from "../../lib/osFileDrop";
import { isWindowsPath, resolvePathInput } from "../../lib/pathCompletion";
import { sftpLocalHome, type FileEntry } from "../../lib/sftp";
import { useSftpStore, type FilePanelStoreHook } from "../../stores/sftpStore";
import { useContextMenu } from "../ContextMenu";
import { createFilePanelInteractions } from "./filePanel/createFilePanelInteractions";
import { FilePanelView } from "./filePanel/FilePanelView";
import { CROSS_PANE_DRAG_MIME } from "./filePanel/preferences";
import { type CrossPaneDragPayload, type FilePanelProps } from "./filePanel/types";
import { useFilePanelColumns } from "./filePanel/useFilePanelColumns";

export function FilePanel({
  sessionId,
  side,
  store,
  subtitle,
  detachable,
  onDetach,
  onItemDoubleClick,
  onItemContext,
  onEmptyContext,
  onCrossPaneDrop,
  acceptCrossPane,
  filterText,
  onFilterTextChange,
  onDownloadSelected,
  onUploadSelected,
  onUploadFromDisk,
  onUploadPathsFromDisk,
  onDeleteSelected,
  onChmodSelected,
  onPreviewSelected,
  onNewFolder,
  onNewFile,
  onOpenTerminalHere,
  onOpenLocalSelected,
  onRevealInOs,
}: FilePanelProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // `store` is stable per mount (see prop docs), so the conditional default
  // resolves to one consistent hook identity across renders.
  const useStore = (store ?? useSftpStore) as FilePanelStoreHook;
  const session = useStore((s) => s.sessions[sessionId]);
  const navigate = useStore((s) => s.navigate);
  const listPath = useStore((s) => s.listPath);
  const navigateBack = useStore((s) => s.navigateBack);
  const navigateForward = useStore((s) => s.navigateForward);
  const navigateUp = useStore((s) => s.navigateUp);
  const refresh = useStore((s) => s.refreshPane);
  const setSelection = useStore((s) => s.setSelection);
  const toggleHidden = useStore((s) => s.toggleHidden);
  const ctx = useContextMenu();

  const [sortKey, setSortKey] = useState<"name" | "size" | "mtime" | "type">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [draggingOver, setDraggingOver] = useState(false);
  const lastClickedRef = useRef<string | null>(null);
  const columns = useFilePanelColumns({
    side,
  });

  const pane = session?.[side];
  const showHidden = pane?.showHidden ?? false;
  const resolveAddress = useCallback(async (value: string) => {
    const home = side === "local" && /^~(?:[\\/]|$)/.test(value)
      ? await sftpLocalHome() : session?.homeDir;
    return resolvePathInput(value, pane?.path ?? "", home, side === "local" && (isWindowsPath(value) || isWindowsPath(pane?.path ?? "")));
  }, [side, session?.homeDir, pane?.path]);
  const listDirectory = useCallback(async (directory: string) => {
    return listPath(sessionId, side, await resolveAddress(directory));
  }, [listPath, sessionId, side, resolveAddress]);
  const submitAddress = useCallback(async (value: string) => {
    try {
      await navigate(sessionId, side, await resolveAddress(value));
    } catch {
      // Home lookup errors still use the pane's normal navigation error path.
      void navigate(sessionId, side, value);
    }
  }, [navigate, sessionId, side, resolveAddress]);
  // Show the drives dropdown only on the LOCAL pane when the current path
  // looks like a Windows path. Lets the user jump back from `C:\foo` to a
  // list of drives (C:, D:, …) without typing the path manually.
  const showDrivesPicker =
    side === "local" &&
    !!pane?.path &&
    (/^[A-Z]:/i.test(pane.path) || pane.path === "\\\\");

  const sortedEntries = useMemo<FileEntry[]>(() => {
    if (!pane) return [];
    let entries = showHidden
      ? pane.entries
      : pane.entries.filter((e) => !e.isHidden);
    if (filterText && filterText.trim()) {
      const needle = filterText.trim().toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(needle));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (a.fileType === "dir" && b.fileType !== "dir") return -1;
      if (b.fileType === "dir" && a.fileType !== "dir") return 1;
      switch (sortKey) {
        case "size":
          return ((a.size ?? 0) - (b.size ?? 0)) * dir;
        case "mtime":
          return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
        case "type": {
          const at = a.fileType + (a.name.split(".").pop() ?? "");
          const bt = b.fileType + (b.name.split(".").pop() ?? "");
          return at.localeCompare(bt) * dir;
        }
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
  }, [pane, sortKey, sortDir, showHidden, filterText]);

  const normalizedFilter = filterText?.trim() ?? "";
  const filterActive = normalizedFilter.length > 0;
  const hiddenEntryCount = pane?.entries.filter((entry) => entry.isHidden).length ?? 0;
  const hiddenBySettingCount = showHidden ? 0 : hiddenEntryCount;
  const filterCandidateCount = Math.max(0, (pane?.entries.length ?? 0) - hiddenBySettingCount);
  const skippedEntryCount = pane?.skippedEntryCount ?? 0;
  const entryDiagnostics = pane?.entryDiagnostics ?? [];
  const diagnosticTitle = entryDiagnostics
    .map((diagnostic, index) => {
      const label = diagnostic.name ?? diagnostic.path ?? `#${index + 1}`;
      return `${label}: ${diagnostic.error}`;
    })
    .join("\n");
  const hasListingStatus = hiddenBySettingCount > 0 || filterActive || skippedEntryCount > 0;

  const onHeaderClick = useCallback(
    (key: typeof sortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey],
  );

  useEffect(() => {
    setSelection(sessionId, side, []);
  }, [sessionId, side, setSelection, pane?.path]);

  useEffect(() => {
    if (side !== "remote" || !onUploadPathsFromDisk) return;

    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;

      const list = listRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!list || !target || !list.contains(target)) return;

      setDraggingOver(false);
      onUploadPathsFromDisk(detail.paths);
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [onUploadPathsFromDisk, side]);

  const selectedEntries = useMemo<FileEntry[]>(() => {
    if (!pane) return [];
    const set = new Set(pane.selection);
    return sortedEntries.filter((e) => set.has(e.path));
  }, [pane, sortedEntries]);

  const firstSelected = selectedEntries[0];
  const canPreview = !!(
    onPreviewSelected &&
    selectedEntries.length === 1 &&
    firstSelected &&
    firstSelected.fileType === "file"
  );

  useCustomDropTarget<HTMLDivElement>(listRef, {
    accepts: (data: CustomDragData) => {
      if (!acceptCrossPane) return false;
      if (data.mime !== CROSS_PANE_DRAG_MIME) return false;
      const payload = data.payload as CrossPaneDragPayload | null;
      if (!payload) return false;
      // Reject same-pane drags so dropping back doesn't trigger a copy.
      return !(payload.sessionId === sessionId && payload.side === side);
    },
    onDragEnter: () => setDraggingOver(true),
    onDragLeave: () => setDraggingOver(false),
    onDrop: (detail) => {
      setDraggingOver(false);
      const payload = detail.data.payload as CrossPaneDragPayload | null;
      if (!payload) return;
      const otherPane = useStore.getState().sessions[payload.sessionId]?.[payload.side];
      if (!otherPane) return;
      const entries = otherPane.entries.filter((entry) => payload.paths.includes(entry.path));
      if (entries.length > 0) onCrossPaneDrop?.(entries);
    },
  });

  if (!pane) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        {t("fileBrowser.paneNotInitialized")}
      </div>
    );
  }
  const interactions = createFilePanelInteractions({
    pane,
    lastClickedRef,
    sortedEntries,
    setSelection,
    sessionId,
    side,
    onItemContext,
    ctx,
    onEmptyContext,
    onUploadFromDisk,
    setDraggingOver,
  });

  const handleMkdir = () => {
    if (onNewFolder) {
      onNewFolder();
      return;
    }
    if (!onEmptyContext) return;
    const items = onEmptyContext({ x: 0, y: 0 });
    const mkdirItem = items.find((it) => it.label.toLowerCase().includes("folder"));
    if (mkdirItem?.onClick) mkdirItem.onClick();
  };

  return <FilePanelView
    side={side}
    subtitle={subtitle}
    onFilterTextChange={onFilterTextChange}
    filterText={filterText}
    t={t}
    onUploadFromDisk={onUploadFromDisk}
    fileInputRef={fileInputRef}
    pane={pane}
    showHidden={showHidden}
    selectedEntries={selectedEntries}
    canPreview={canPreview}
    navigateBack={navigateBack}
    sessionId={sessionId}
    navigateForward={navigateForward}
    navigateUp={navigateUp}
    refresh={refresh}
    handleMkdir={handleMkdir}
    onNewFile={onNewFile}
    onDeleteSelected={onDeleteSelected}
    onChmodSelected={onChmodSelected}
    onPreviewSelected={onPreviewSelected}
    firstSelected={firstSelected}
    onDownloadSelected={onDownloadSelected}
    onUploadSelected={onUploadSelected}
    onOpenLocalSelected={onOpenLocalSelected}
    onRevealInOs={onRevealInOs}
    onOpenTerminalHere={onOpenTerminalHere}
    toggleHidden={toggleHidden}
    detachable={detachable}
    onDetach={onDetach}
    showDrivesPicker={showDrivesPicker}
    navigate={navigate}
    session={session}
    submitAddress={submitAddress}
    listDirectory={listDirectory}
    hasListingStatus={hasListingStatus}
    skippedEntryCount={skippedEntryCount}
    diagnosticTitle={diagnosticTitle}
    hiddenBySettingCount={hiddenBySettingCount}
    filterActive={filterActive}
    sortedEntries={sortedEntries}
    filterCandidateCount={filterCandidateCount}
    normalizedFilter={normalizedFilter}
    listRef={listRef}
    interactions={interactions}
    ctx={ctx}
    draggingOver={draggingOver}
    columns={columns}
    sortKey={sortKey}
    sortDir={sortDir}
    onHeaderClick={onHeaderClick}
    onItemDoubleClick={onItemDoubleClick}
  />;
}

export { basename, parentPath } from "../../lib/sftp";

export { isPreviewable } from "./filePanel/preview";
