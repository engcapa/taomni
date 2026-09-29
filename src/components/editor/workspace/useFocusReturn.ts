import { useLayoutEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";

function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * Focus `element`; a CodeMirror content node is focused through its view so
 * the editor keeps its selection (a raw DOM focus lets the browser put the
 * DOM caret at the start, which CodeMirror then reads back as 1:1).
 */
function focusElement(element: HTMLElement): void {
  const view = element.classList.contains("cm-content") ? EditorView.findFromDOM(element) : null;
  if (view) view.focus();
  else element.focus({ preventScroll: true });
}

/**
 * DEC-ALIGN-11 focus return for popups/dialogs: remember the element that had
 * focus when the surface opened and give focus back when it closes. When that
 * element is gone (or was the document body because the opener already
 * closed), `fallback` restores the editing context instead — normally the
 * active editor view. A surface that took focus in the meantime (a dialog the
 * popup opened, a newly opened file) keeps it: focus is only restored when it
 * would otherwise be lost.
 */
export function useFocusReturn(active: boolean, fallback?: () => void): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useLayoutEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Defer until the surface's DOM is gone so its own blur handling cannot
      // steal focus back.
      const restore = () => {
        if (!focusIsLost()) return;
        const usable = trigger
          && trigger !== document.body
          && trigger.isConnected
          && !trigger.closest("[inert]");
        if (usable) {
          focusElement(trigger);
          if (document.activeElement === trigger) return;
        }
        fallbackRef.current?.();
      };
      if (typeof queueMicrotask === "function") queueMicrotask(restore);
      else restore();
    };
  }, [active]);
}
