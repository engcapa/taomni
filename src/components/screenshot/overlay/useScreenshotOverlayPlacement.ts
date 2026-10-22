import { useEffect, useLayoutEffect } from "react";
import type { useScreenshotOverlayState } from "./useScreenshotOverlayState";


export interface UseScreenshotOverlayPlacementContext {
  state: ReturnType<typeof useScreenshotOverlayState>;
}

export function useScreenshotOverlayPlacement(context: UseScreenshotOverlayPlacementContext) {
  const { state } = context;

  // ---------------------------------------------------------------------
  // Toolbar placement: below the selection, else above, else inside;
  // horizontally clamped to the viewport using its measured width.
  // ---------------------------------------------------------------------

  useLayoutEffect(() => {
    if (!state.sel || state.phase !== "annotate" || state.dragging) {
      state.setToolbarPos(null);
      return;
    }
    const el = state.toolbarRef.current;
    const w = el?.offsetWidth ?? 600;
    const h = el?.offsetHeight ?? 44;
    const gap = 8;
    let top: number;
    if (state.scrollResult) top = state.viewport.h - h - 12;
    else if (state.sel.y + state.sel.h + gap + h <= state.viewport.h - 4) top = state.sel.y + state.sel.h + gap;
    else if (state.sel.y - gap - h >= 4) top = state.sel.y - gap - h;
    else top = Math.max(8, state.viewport.h - h - 12);
    top = Math.min(Math.max(4, top), Math.max(4, state.viewport.h - h - 4));
    const left = Math.min(Math.max(4, state.sel.x + state.sel.w - w), Math.max(4, state.viewport.w - w - 4));
    state.setToolbarPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [state.sel, state.phase, state.dragging, state.viewport.w, state.viewport.h, state.ocrOpen, state.tool, state.textSelected, state.scrollResult, state.moreOpen, state.fillableSelected]);

  useLayoutEffect(() => {
    if (!state.recordOpen) return;
    const button = state.recordButtonRef.current?.getBoundingClientRect();
    const menu = state.recordMenuRef.current;
    if (!button || !menu) return;
    const left = Math.max(8, Math.min(button.right - menu.offsetWidth, state.viewport.w - menu.offsetWidth - 8));
    const above = button.top - menu.offsetHeight - 8;
    const top = above >= 8 ? above : Math.max(8, Math.min(button.bottom + 8, state.viewport.h - menu.offsetHeight - 8));
    state.setRecordPos({ left, top });
  }, [state.recordOpen, state.toolbarPos, state.viewport]);

  useLayoutEffect(() => {
    if (!state.watermarkOpen) return;
    const button = state.watermarkButtonRef.current?.getBoundingClientRect();
    const panel = state.watermarkPanelRef.current;
    if (!button || !panel) return;
    const left = Math.max(8, Math.min(button.right - panel.offsetWidth, state.viewport.w - panel.offsetWidth - 8));
    const above = button.top - panel.offsetHeight - 8;
    const below = button.bottom + 8;
    const top = state.scrollResult && below + panel.offsetHeight <= state.viewport.h - 8
      ? below
      : above >= 8 ? above : Math.max(8, Math.min(below, state.viewport.h - panel.offsetHeight - 8));
    state.setWatermarkPos({ left, top });
  }, [state.watermarkOpen, state.toolbarPos, state.viewport, state.scrollResult, state.tool, state.textSelected]);

  useEffect(() => {
    if (!state.recordOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!state.recordButtonRef.current?.contains(event.target as Node)) state.setRecordOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [state.recordOpen]);

}
