import { useCallback, useEffect, useState, type RefObject } from "react";

export const DEFAULT_DB_SESSION_FONT_SIZE = 13;
const MIN_DB_SESSION_FONT_SIZE = 8;
const MAX_DB_SESSION_FONT_SIZE = 32;
const STORAGE_KEY = "taomni.db.sessionFontSize.v1";

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DB_SESSION_FONT_SIZE;
  return Math.min(MAX_DB_SESSION_FONT_SIZE, Math.max(MIN_DB_SESSION_FONT_SIZE, Math.round(value)));
}

function readStoredFontSize(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null || stored.trim() === "") return DEFAULT_DB_SESSION_FONT_SIZE;
    const raw = Number(stored);
    return Number.isFinite(raw) ? clampFontSize(raw) : DEFAULT_DB_SESSION_FONT_SIZE;
  } catch {
    return DEFAULT_DB_SESSION_FONT_SIZE;
  }
}

function writeStoredFontSize(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampFontSize(value)));
  } catch {
    /* ignore */
  }
}

export function useDbSessionFontSize(visible: boolean, rootRef: RefObject<HTMLElement>) {
  const [fontSize, setFontSize] = useState(readStoredFontSize);

  useEffect(() => {
    writeStoredFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    if (visible) setFontSize(readStoredFontSize());
  }, [visible]);

  const increaseFontSize = useCallback(() => {
    setFontSize((size) => clampFontSize(size + 1));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setFontSize((size) => clampFontSize(size - 1));
  }, []);

  const resetFontSize = useCallback(() => {
    setFontSize(DEFAULT_DB_SESSION_FONT_SIZE);
  }, []);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        increaseFontSize();
        return;
      }
      if (event.ctrlKey && (event.key === "-" || event.key === "_")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        decreaseFontSize();
        return;
      }
      if (event.ctrlKey && event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetFontSize();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [decreaseFontSize, increaseFontSize, resetFontSize, visible]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, rootRef, visible]);

  return { fontSize, increaseFontSize, decreaseFontSize, resetFontSize };
}
