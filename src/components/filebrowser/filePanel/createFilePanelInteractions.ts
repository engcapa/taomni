import { type DragEvent, type MouseEvent } from "react";
import { startCustomDrag } from "../../../lib/customDnD";
import { droppedFiles, isOsFileDrag } from "../../../lib/osFileDrop";
import { type FileEntry } from "../../../lib/sftp";
import { useContextMenu } from "../../ContextMenu";
import { CROSS_PANE_DRAG_MIME } from "./preferences";
import { type CrossPaneDragPayload } from "./types";

export interface CreateFilePanelInteractionsContext {
  pane: import("../../../stores/sftpStore").PaneState;
  lastClickedRef: import("react").RefObject<string | null>;
  sortedEntries: FileEntry[];
  setSelection: (sessionId: string, side: import("../../../stores/sftpStore").PaneSide, selection: string[]) => void;
  sessionId: string;
  side: import("../../../stores/sftpStore").PaneSide;
  onItemContext: ((entry: FileEntry, anchor: { x: number; y: number; }, selectedEntries: FileEntry[]) => import("../../ContextMenu").MenuItem[]) | undefined;
  ctx: ReturnType<typeof useContextMenu>;
  onEmptyContext: ((anchor: { x: number; y: number; }) => import("../../ContextMenu").MenuItem[]) | undefined;
  onUploadFromDisk: ((files: File[]) => void) | undefined;
  setDraggingOver: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}

export function createFilePanelInteractions(context: CreateFilePanelInteractionsContext) {
  const {
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
  } = context;

  const handleRowClick = (entry: FileEntry, e: MouseEvent) => {
    const selection = pane.selection.slice();
    if (e.shiftKey && lastClickedRef.current) {
      const start = sortedEntries.findIndex((x) => x.path === lastClickedRef.current);
      const end = sortedEntries.findIndex((x) => x.path === entry.path);
      if (start >= 0 && end >= 0) {
        const [a, b] = start < end ? [start, end] : [end, start];
        const range = sortedEntries.slice(a, b + 1).map((x) => x.path);
        setSelection(sessionId, side, range);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const idx = selection.indexOf(entry.path);
      if (idx >= 0) selection.splice(idx, 1);
      else selection.push(entry.path);
      setSelection(sessionId, side, selection);
    } else {
      setSelection(sessionId, side, [entry.path]);
    }
    lastClickedRef.current = entry.path;
  };

  const handleRowContext = (entry: FileEntry, e: MouseEvent) => {
    e.preventDefault();
    const effectiveSelection = pane.selection.includes(entry.path)
      ? pane.selection
      : [entry.path];
    if (!pane.selection.includes(entry.path)) {
      setSelection(sessionId, side, effectiveSelection);
    }
    if (!onItemContext) return;
    const selectedSet = new Set(effectiveSelection);
    const contextEntries = sortedEntries.filter((x) => selectedSet.has(x.path));
    const items = onItemContext(
      entry,
      { x: e.clientX, y: e.clientY },
      contextEntries.length > 0 ? contextEntries : [entry],
    );
    if (items.length > 0) ctx.show(e, items);
  };

  const handleEmptyContext = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-row]")) return;
    e.preventDefault();
    if (!onEmptyContext) return;
    const items = onEmptyContext({ x: e.clientX, y: e.clientY });
    if (items.length > 0) ctx.show(e, items);
  };

  const handleEmptyClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-row]")) return;
    setSelection(sessionId, side, []);
  };

  const handleRowPointerDown = (entry: FileEntry, e: React.PointerEvent<HTMLTableRowElement>) => {
    if (e.button !== 0) return;
    const sel = pane.selection.includes(entry.path) ? pane.selection : [entry.path];
    const ghostText = sel.length === 1 ? entry.name : `${sel.length} items`;
    startCustomDrag({
      event: e,
      data: {
        mime: CROSS_PANE_DRAG_MIME,
        payload: {
          sessionId,
          side,
          paths: sel,
        } satisfies CrossPaneDragPayload,
      },
      ghostText,
    });
  };

  // Browser dev mode: OS file drag delivers `File` objects through HTML5 DnD.
  // Inside Tauri, OS file drops arrive via `NATIVE_FILE_DROP_EVENT` instead
  // (because dragDropEnabled=true intercepts HTML5 file drops on Windows).
  // Cross-pane intra-app drag is handled by useCustomDropTarget below.
  const handleDragOver = (e: DragEvent) => {
    if (side === "remote" && onUploadFromDisk && isOsFileDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDraggingOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setDraggingOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (side === "remote" && onUploadFromDisk && isOsFileDrag(e.dataTransfer)) {
      e.preventDefault();
      setDraggingOver(false);
      const files = droppedFiles(e.dataTransfer);
      if (files.length > 0) onUploadFromDisk(files);
    }
  };
  return {
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleEmptyContext,
    handleEmptyClick,
    handleRowPointerDown,
    handleRowClick,
    handleRowContext,
  };
}
