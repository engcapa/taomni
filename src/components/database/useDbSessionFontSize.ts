import { useCallback, useEffect, useState, type RefObject } from "react";

import { contentZoomShortcut, nextFontOffset, zoomedFontSize, type ContentZoomAction } from "../../lib/contentZoomShortcut";

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

// Retain the user's previously saved base. Zooming a session is temporary.
export function useDbSessionFontSize(visible: boolean, rootRef: RefObject<HTMLElement | null>) {
  const [base] = useState(readStoredFontSize);
  const [offset, setOffset] = useState(0);
  const change = useCallback((action: ContentZoomAction) => {
    setOffset((current) => nextFontOffset(action, base, current));
  }, [base]);

  useEffect(() => {
    if (!visible) return;
    const owns = (event: Event) => event.target instanceof Node && rootRef.current?.contains(event.target);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !owns(event)) return;
      const action = contentZoomShortcut(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      change(action);
    };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || !event.ctrlKey || !owns(event) || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      change(event.deltaY < 0 ? "in" : "out");
    };
    // Connection and workspace views can replace the root after mount.
    // Resolve the ref at dispatch so only the focused session handles the event.
    document.addEventListener("keydown", keydown);
    document.addEventListener("wheel", wheel, { passive: false });
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("wheel", wheel);
    };
  }, [visible, change, rootRef]);

  return {
    fontSize: zoomedFontSize(base, offset),
    increaseFontSize: () => change("in"),
    decreaseFontSize: () => change("out"),
    resetFontSize: () => change("reset"),
  };
}
