import { useEffect } from "react";
import type { useScreenshotOverlayState } from "./useScreenshotOverlayState";


export interface UseScreenshotOverlayKeyboardContext {
  state: ReturnType<typeof useScreenshotOverlayState>;
  selection: { exitPickerMode: () => void; resetSelection: () => void; startRegionDrag: (x: number, y: number) => void; changeSelectionMode: (mode: "rectangle" | "freehand") => void; enterPickerMode: () => void; handleSelectMouseDown: (e: import("react").MouseEvent) => void; handleDoubleClick: (e: import("react").MouseEvent) => void; startHandleDrag: (e: import("react").MouseEvent, handle: import("./types").Handle) => void; fullscreenSelect: () => void; handlePickerMove: (e: import("react").MouseEvent) => void; handlePickerPick: () => Promise<void>; };
  handleCopy: () => Promise<void> | undefined;
  handleSave: () => Promise<void>;
}

export function useScreenshotOverlayKeyboard(context: UseScreenshotOverlayKeyboardContext) {
  const { state, selection, handleCopy, handleSave } = context;

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable='true']");
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (state.pinDoneOpen) { e.preventDefault(); if (!state.busyRef.current) state.setPinDoneOpen(false); return; }
        e.preventDefault();
        if (state.scrollError) state.close();
        else if (state.editOpen) state.setEditOpen(false);
        else if (state.scrollConfirm) state.setScrollConfirm(false);
        else if (state.recordOpen) state.setRecordOpen(false);
        else if (state.watermarkOpen) state.setWatermarkOpen(false);
        else if (state.ocrOpen) state.setOcrOpen(false);
        else if (state.pickerMode) selection.exitPickerMode();
        else if (state.scrollResult) state.close();
        else if (state.phase === "annotate" && state.tool !== "select" && state.canvasRef.current?.shapeCount() === 0) state.setTool("select");
        else if (state.phase === "annotate") selection.resetSelection();
        else state.close();
        return;
      }
      if (state.pinDoneOpen || typing || state.editOpen || state.editBusy || (state.phase !== "annotate" && state.phase !== "preview")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && state.tool === "move") {
        if (state.canvasRef.current?.deleteSelected()) e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) state.canvasRef.current?.redo();
        else state.canvasRef.current?.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        state.canvasRef.current?.redo();
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopy();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void handleCopy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

}
