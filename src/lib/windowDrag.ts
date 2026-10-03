import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Preserve the native title-bar gestures on explicit window-move regions. */
export function startWindowDrag(event: MouseEvent) {
  if (event.button !== 0) return;
  if (!(event.target instanceof Element) || !event.target.closest("[data-window-drag]")) return;
  event.preventDefault();
  event.stopPropagation();
  const win = getCurrentWindow();
  if (event.detail === 2) {
    void win.toggleMaximize().catch(() => {});
  } else {
    void win.startDragging().catch(() => {});
  }
}
