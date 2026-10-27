import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Title bars contain tabs, popup portals and nested SVG icons. Moving their
// background must never consume the interaction belonging to those controls.
const INTERACTIVE_TARGET = [
  "button", "a[href]", "input", "textarea", "select", "summary",
  "[role='button']", "[role='tab']", "[role='menu']", "[role='menuitem']",
  "[role='option']", "[role='slider']", "[role='separator']", "[tabindex]",
  "[draggable='true']", "[contenteditable]:not([contenteditable='false'])",
  "[data-taomni-context-menu]", "[data-window-drag='false']",
].join(",");

/** Preserve native title-bar gestures while leaving nested controls operable. */
export function startWindowDrag(event: MouseEvent) {
  if (event.button !== 0 || event.defaultPrevented) return;
  if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
  if (!event.target.closest("[data-window-drag]") || event.target.closest(INTERACTIVE_TARGET)) return;
  event.preventDefault();
  event.stopPropagation();
  const win = getCurrentWindow();
  if (event.detail === 2) {
    void win.toggleMaximize().catch(() => {});
  } else {
    void win.startDragging().catch(() => {});
  }
}
