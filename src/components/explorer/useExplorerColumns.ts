import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { FileEntry } from "../../lib/sftp";
import { getExplorerPreferences, setExplorerPreferences } from "./explorerPreferences";
import { clampExplorerColumn, DEFAULT_EXPLORER_WIDTHS, explorerColumnLayout, fitExplorerColumn, type ExplorerColumn, type ExplorerColumnWidths, type ExplorerLabel } from "./explorerColumns";

export function useExplorerColumns(enabled: boolean, widths: ExplorerColumnWidths, entries: FileEntry[], label: ExplorerLabel,
  head: RefObject<HTMLDivElement | null>) {
  const [draft, setDraft] = useState<{ key: ExplorerColumn; width: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const commit = (key: ExplorerColumn, width?: number) => {
    const columnWidths = { ...getExplorerPreferences().columnWidths };
    if (width === undefined) delete columnWidths[key];
    else columnWidths[key] = clampExplorerColumn(key, width);
    setExplorerPreferences({ columnWidths });
  };
  const measuredWidth = (key: ExplorerColumn) => head.current?.querySelector<HTMLElement>(`[data-column="${key}"]`)?.getBoundingClientRect().width
    || widths[key] || DEFAULT_EXPLORER_WIDTHS[key];
  useEffect(() => {
    if (!enabled) { cleanupRef.current?.(); setDraft(null); }
    return () => cleanupRef.current?.();
  }, [enabled]);

  const startResize = (key: ExplorerColumn, event: PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); event.stopPropagation();
    cleanupRef.current?.();
    const handle = event.currentTarget, pointerId = event.pointerId, startX = event.clientX, startWidth = measuredWidth(key);
    let width = startWidth;
    const cleanup = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", blur);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      cleanupRef.current = null;
    };
    const end = (save: boolean) => { cleanup(); setDraft(null); if (save) commit(key, width); };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      width = clampExplorerColumn(key, startWidth + next.clientX - startX);
      setDraft({ key, width });
    };
    const finish = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) end(true); };
    const cancel = (next: Event) => { if (!("pointerId" in next) || next.pointerId === pointerId) end(false); };
    const blur = () => end(true);
    cleanupRef.current = cleanup;
    handle.focus();
    handle.setPointerCapture?.(pointerId);
    handle.addEventListener("lostpointercapture", cancel);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", blur);
  };

  const fit = (key: ExplorerColumn) => {
    const context = document.createElement("canvas").getContext("2d");
    const element = head.current?.closest(".ex-files");
    if (context && element) context.font = getComputedStyle(element).font || "12.5px sans-serif";
    commit(key, fitExplorerColumn(key, entries, label, text => context?.measureText(text).width ?? Array.from(text).length * 9));
  };
  const resizeKey = (key: ExplorerColumn, event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Home") commit(key);
    else commit(key, measuredWidth(key) + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 50 : 10));
  };
  const effective = draft ? { ...widths, [draft.key]: draft.width } : widths;
  return { ...explorerColumnLayout(effective), effective, measuredWidth, startResize, fit, resizeKey };
}
