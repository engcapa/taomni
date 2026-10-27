import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY = "taomni.platform.rightContextWidth.v1";
const clamp = (value: number) => Math.max(220, Math.min(480, value));

export function useContextPanelWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(KEY));
      return saved ? clamp(saved) : 300;
    } catch { return 300; }
  });
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const resize = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    try { localStorage.setItem(KEY, String(next)); } catch { /* In-memory resize remains available. */ }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();
    const startX = event.clientX;
    const onMove = (move: globalThis.PointerEvent) => resize(width + startX - move.clientX);
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cleanupRef.current = null;
    };
    cleanupRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      resize(width + (event.key === "ArrowLeft" ? 10 : -10));
    } else if (event.key === "Home") {
      event.preventDefault();
      resize(300);
    }
  };
  return { width, onPointerDown, onKeyDown, reset: () => resize(300) };
}
