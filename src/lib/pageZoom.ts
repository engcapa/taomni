import { contentZoomShortcut, type ContentZoomAction } from "./contentZoomShortcut";
import { getAppPlatform } from "./runtime";

export const pageZoomCommands = [
  { id: "zoom-in", action: "in", label: "menu.zoomIn", key: "+" },
  { id: "zoom-out", action: "out", label: "menu.zoomOut", key: "-" },
  { id: "zoom-reset", action: "reset", label: "menu.zoomReset", key: "0" },
] as const;

export function zoomBinding(key: string, mac = getAppPlatform() === "macos") {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

interface ZoomTarget {
  element: () => HTMLElement | null;
  change: (action: ContentZoomAction, focus: Element | null) => void;
  pageKeyboard: boolean;
}

// Each WebView owns its own targets. Keep the last content focus while the
// renderer menu or AppKit has focus, and recheck visibility before dispatch.
const targets = new Set<ZoomTarget>();
let lastFocus: Element | null = null;

function visibleTargets() {
  return [...targets].filter((target) => target.element()?.getClientRects().length);
}

function containing(available: ZoomTarget[], node: Element | null) {
  if (!node) return;
  for (let element: Element | null = node; element; element = element.parentElement) {
    const match = available.find((target) => target.element() === element);
    if (match) return match;
  }
}

function remember(event: Event) {
  if (event.target instanceof Element && containing([...targets], event.target)) lastFocus = event.target;
}

function dispatch(action: ContentZoomAction, keyboard: boolean, focused: Element | null) {
  const dialogs = document.querySelectorAll('dialog[open], [aria-modal="true"]');
  if (Array.from(dialogs).some((dialog) => dialog.getClientRects().length)) return false;
  const available = visibleTargets();
  const focus = containing(available, focused) ? focused : lastFocus;
  const target = containing(available, focus) ?? available[0];
  if (!target || (keyboard && !target.pageKeyboard)) return false;
  target.change(action, target.element()?.contains(focus) ? focus : null);
  return true;
}

export function zoomFromMenu(action: ContentZoomAction) {
  return dispatch(action, false, document.activeElement);
}

function keydown(event: KeyboardEvent) {
  const action = !event.defaultPrevented && contentZoomShortcut(event);
  if (!action || (event.target instanceof Element && event.target.closest('[role="menu"], [aria-haspopup="listbox"][aria-expanded="true"], .taomni-select-options'))) return;
  if (dispatch(action, true, event.target instanceof Element ? event.target : null)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

export function registerZoomTarget(target: ZoomTarget) {
  if (!targets.size) {
    window.addEventListener("keydown", keydown);
    document.addEventListener("focusin", remember, true);
    document.addEventListener("pointerdown", remember, true);
  }
  targets.add(target);
  return () => {
    targets.delete(target);
    if (lastFocus && !containing([...targets], lastFocus)) lastFocus = null;
    if (targets.size) return;
    window.removeEventListener("keydown", keydown);
    document.removeEventListener("focusin", remember, true);
    document.removeEventListener("pointerdown", remember, true);
  };
}
