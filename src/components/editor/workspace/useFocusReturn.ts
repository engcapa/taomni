import { useLayoutEffect, useRef } from "react";

/**
 * DEC-ALIGN-11 focus return for popups/dialogs: remember the element that had
 * focus when the surface mounted and give focus back when it unmounts. When
 * that element is gone (or was the document body because the opener already
 * closed), `fallback` restores the editing context instead — normally the
 * active editor view.
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
        const usable = trigger
          && trigger !== document.body
          && trigger.isConnected
          && !trigger.closest("[inert]");
        if (usable) {
          trigger.focus({ preventScroll: true });
          if (document.activeElement === trigger) return;
        }
        fallbackRef.current?.();
      };
      if (typeof queueMicrotask === "function") queueMicrotask(restore);
      else restore();
    };
  }, [active]);
}
