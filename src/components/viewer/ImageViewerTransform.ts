import { useCallback, useEffect, useRef, useState } from "react";
import { clampImageScale, fitImageScale } from "./ImageViewerImage";

export function useImageTransform(path: string, width: number, height: number, layout: string) {
  const stage = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<"fit" | "actual" | "custom">("fit");
  const [manualScale, setManualScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const scale = mode === "fit" ? fitImageScale(width, height, viewport.width, viewport.height, rotation) : mode === "actual" ? 1 : manualScale;

  useEffect(() => {
    setMode("fit"); setRotation(0); setFlipped(false); setPan({ x: 0, y: 0 }); setPanning(false);
    drag.current = null;
  }, [path]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [layout]);

  const zoom = useCallback((factor: number, point?: { x: number; y: number }) => {
    const next = clampImageScale(scale * factor);
    const ratio = next / scale;
    setPan((current) => ({ x: (point?.x ?? 0) - ((point?.x ?? 0) - current.x) * ratio,
      y: (point?.y ?? 0) - ((point?.y ?? 0) - current.y) * ratio }));
    setManualScale(next); setMode("custom");
  }, [scale]);
  const reset = (next: "fit" | "actual") => { setMode(next); setPan({ x: 0, y: 0 }); };
  return {
    stage, mode, scale, rotation, flipped, pan, panning, zoom, reset,
    wheel: (event: React.WheelEvent<HTMLDivElement>) => {
      if (!width || !height) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.002), {
        x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2,
      });
    },
    rotate: (direction: number) => { setRotation((value) => (value + direction * 90 + 360) % 360); setPan({ x: 0, y: 0 }); },
    flip: () => setFlipped((value) => !value),
    pointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !width || !height || (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setPanning(true);
    },
    pointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (!active || active.id !== event.pointerId) return;
      setPan({ x: active.originX + event.clientX - active.x, y: active.originY + event.clientY - active.y });
    },
    pointerEnd: (event: React.PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null; setPanning(false);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
  };
}
