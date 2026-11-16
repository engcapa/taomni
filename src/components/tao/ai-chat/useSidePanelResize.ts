import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

const DEFAULT_WIDTH = 340;

/** Own the drag lifecycle independently of which companion view is selected. */
export function useSidePanelResize(open: boolean) {
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; width: number } | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const bounds = useCallback(() => {
    const available = panelRef.current?.parentElement?.clientWidth || 1000;
    // Reserve a usable chat column, including in narrow native windows.
    const max = Math.min(560, Math.max(available / 2, available - 320));
    return { min: Math.min(260, max), max };
  }, []);
  const clamp = useCallback((value: number) => {
    const { min, max } = bounds();
    return Math.min(max, Math.max(min, value));
  }, [bounds]);
  useEffect(() => {
    if (!open) return;
    const container = panelRef.current?.parentElement;
    const fit = () => setWidth((value) => clamp(value));
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    if (container) observer?.observe(container);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [clamp, open]);
  useEffect(() => {
    if (!open) { drag.current = null; setResizing(false); return; }
    const move = (event: globalThis.MouseEvent) => {
      const start = drag.current;
      if (start) setWidth(clamp(start.width + start.startX - event.clientX));
    };
    const stop = () => { drag.current = null; setResizing(false); };
    window.addEventListener("mousemove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [clamp, open]);
  const beginResize = (event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, width };
    setResizing(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { min, max } = bounds();
    const next = { ArrowLeft: width + 20, ArrowRight: width - 20, Home: min, End: max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(clamp(next));
  };
  return { panelRef, width, resizing, beginResize, onKeyDown, resetWidth: () => setWidth(clamp(DEFAULT_WIDTH)) };
}
