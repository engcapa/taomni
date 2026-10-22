import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect } from "react";
import { normalizeRect } from "../../../lib/screenshot";
import { contourBounds, pointInContour, transformContour, validContour } from "../../../lib/screenshotSelection";
import { dragRect, MIN_SEL } from "./geometry";
import { type Handle } from "./types";
import { useScreenshotOverlayState } from "./useScreenshotOverlayState";


export interface UseScreenshotSelectionContext {
  state: ReturnType<typeof useScreenshotOverlayState>;
  handleCopy: () => Promise<void> | undefined;
}

export function useScreenshotSelection(context: UseScreenshotSelectionContext) {
  const { state } = context;

  // ---------------------------------------------------------------------
  // Color picker
  // ---------------------------------------------------------------------

  const enterPickerMode = useCallback(() => {
    if (!state.img) return;
    try {
      const c = document.createElement("canvas");
      c.width = state.img.naturalWidth;
      c.height = state.img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(state.img, 0, 0);
      state.pickerCacheRef.current = ctx.getImageData(0, 0, c.width, c.height);
      state.setPickerInfo(null);
      state.setPickerMode(true);
    } catch {
      state.showToast(state.t("screenshot.pickerUnavailable"));
    }
  }, [state.img, state.showToast, state.t]);

  const exitPickerMode = useCallback(() => {
    state.setPickerMode(false);
    state.setPickerInfo(null);
    state.pickerCacheRef.current = null;
  }, []);

  const handlePickerMove = (e: ReactMouseEvent) => {
    const cache = state.pickerCacheRef.current;
    if (!cache) return;
    const preview = state.scrollResult ? document.querySelector('[data-testid="screenshot-scroll-result-image"]')?.getBoundingClientRect() : null;
    const x = Math.max(0, Math.min(cache.width - 1, Math.floor(preview ? (e.clientX - preview.left) * cache.width / preview.width : e.clientX * state.sx)));
    const y = Math.max(0, Math.min(cache.height - 1, Math.floor(preview ? (e.clientY - preview.top) * cache.height / preview.height : e.clientY * state.sy)));
    const i = (y * cache.width + x) * 4;
    const [r, g, b] = [cache.data[i], cache.data[i + 1], cache.data[i + 2]];
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    state.setPickerInfo({ x: e.clientX, y: e.clientY, hex, rgb: `rgb(${r}, ${g}, ${b})` });
  };

  const handlePickerPick = async () => {
    if (!state.pickerInfo) return;
    try {
      const { writeText } = await import("../../../lib/clipboard");
      await writeText(state.pickerInfo.hex);
      state.showToast(state.t("screenshot.pickerCopied", { color: state.pickerInfo.hex }));
    } catch {
      state.showToast(state.t("screenshot.pickerCopyFailed"));
    }
    exitPickerMode();
  };

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------

  const fullscreenSelect = useCallback(() => {
    state.setSel({ x: 0, y: 0, w: state.imageSize.w, h: state.imageSize.h });
    state.setContour(null);
    state.setSelectionMode("rectangle");
    state.setTool("select");
    state.setPhase("annotate");
  }, [state.imageSize.w, state.imageSize.h]);

  /** Drop the selection and annotations; back to region selection. */
  const resetSelection = useCallback(() => {
    state.setScrollError(null);
    state.canvasRef.current?.clear();
    state.dragRef.current = null;
    state.setDragging(false);
    state.setSel(null);
    state.setContour(null);
    state.setTool("select");
    state.setRecordOpen(false);
    state.setWatermarkOpen(false);
    state.setPhase("select");
  }, []);

  const changeSelectionMode = (mode: "rectangle" | "freehand") => {
    if (mode === state.selectionMode) return;
    exitPickerMode();
    state.setRecordOpen(false);
    state.setSelectionMode(mode);
    state.setTool("select");
    if (mode === "rectangle") state.setContour(null);
    else resetSelection();
  };

  const pointInSel = (x: number, y: number): boolean =>
    state.sel !== null && (state.contour ? pointInContour({ x, y }, state.contour)
      : x >= state.sel.x && x <= state.sel.x + state.sel.w && y >= state.sel.y && y <= state.sel.y + state.sel.h);

  const startRegionDrag = (x: number, y: number) => {
    const start = { x, y, w: 0, h: 0 };
    const points = state.selectionMode === "freehand" ? [{ x, y }] : null;
    state.dragRef.current = { kind: points ? "freehand" : "select", origin: { x, y }, start, current: start, points };
    state.setContour(points);
    state.setDragging(true);
    state.setSel(start);
  };

  /** Mousedown on the base layer (outside any shape tool). */
  const handleSelectMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || state.phase === "busy" || state.phase === "loading") return;
    if (state.phase === "select") {
      startRegionDrag(e.clientX, e.clientY);
    } else if (state.phase === "annotate" && !pointInSel(e.clientX, e.clientY)) {
      // Feishu: pressing outside the selection starts a new one.
      resetSelection();
      startRegionDrag(e.clientX, e.clientY);
    }
  };

  const startHandleDrag = (e: ReactMouseEvent, handle: Handle) => {
    if (e.button !== 0 || !state.sel) return;
    e.stopPropagation();
    e.preventDefault();
    state.dragRef.current = { kind: handle, origin: { x: e.clientX, y: e.clientY }, start: state.sel, current: state.sel, points: state.contour };
    state.setDragging(true);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      state.setCursor({ x: e.clientX, y: e.clientY });
      const d = state.dragRef.current;
      if (!d) return;
      const point = {
        x: Math.min(Math.max(0, e.clientX), state.viewport.w),
        y: Math.min(Math.max(0, e.clientY), state.viewport.h),
      };
      if (d.kind === "freehand" && d.points) {
        const last = d.points[d.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) >= 1) {
          // Keep memory/render cost bounded for long gestures without losing the endpoint.
          if (d.points.length >= 4096) d.points = d.points.filter((_, i) => i % 2 === 0);
          d.points.push(point);
        }
        d.current = contourBounds(d.points) ?? d.start;
        state.setContour([...d.points]);
      } else {
        d.current = d.kind === "select"
          ? normalizeRect(d.origin, point)
          : dragRect(d.start, d.kind as Handle, point.x - d.origin.x, point.y - d.origin.y, state.viewport.w, state.viewport.h);
        if (d.points) state.setContour(transformContour(d.points, d.start, d.current));
      }
      state.setSel(d.current);
    };
    const onUp = (e: MouseEvent) => {
      const d = state.dragRef.current;
      if (!d) return;
      onMove(e);
      state.dragRef.current = null;
      state.setDragging(false);
      const selecting = d.kind === "select" || d.kind === "freehand";
      if (d.current.w < MIN_SEL || d.current.h < MIN_SEL
        || (d.kind === "freehand" && !validContour(d.points ?? [], MIN_SEL))) {
        state.setSel(selecting ? null : d.start);
        state.setContour(selecting ? null : d.points);
        if (selecting) state.setPhase("select");
      } else if (selecting) {
        state.setTool("select");
        state.setPhase("annotate");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [state.viewport.w, state.viewport.h]);

  const handleDoubleClick = (e: ReactMouseEvent) => {
    if (state.phase === "busy" || state.phase === "loading" || !state.img) return;
    if (state.phase === "select") {
      fullscreenSelect();
    } else if (state.phase === "annotate" && pointInSel(e.clientX, e.clientY) && state.tool === "select") {
      void context.handleCopy();
    }
  };
  return {
    exitPickerMode,
    resetSelection,
    startRegionDrag,
    changeSelectionMode,
    enterPickerMode,
    handleSelectMouseDown,
    handleDoubleClick,
    startHandleDrag,
    fullscreenSelect,
    handlePickerMove,
    handlePickerPick,
  };
}
