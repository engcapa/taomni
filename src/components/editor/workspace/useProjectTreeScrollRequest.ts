import type { Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { ProjectTreeRow } from "./projectTreeRows";

/** Own measurement retries so an old target cannot undo newer navigation. */
export function useProjectTreeScrollRequest(
  list: Virtualizer<HTMLElement, Element>,
  rows: readonly ProjectTreeRow[],
  enabled: boolean,
) {
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const request = useRef<{ frame: number | null } | null>(null);
  const cancel = useCallback(() => {
    if (request.current?.frame !== null && request.current?.frame !== undefined) {
      cancelAnimationFrame(request.current.frame);
    }
    request.current = null;
  }, []);

  const reveal = useCallback((index: number) => {
    cancel();
    const key = latestRows.current[index]?.key;
    if (!enabled || key === undefined) return;
    const current = { frame: null as number | null };
    request.current = current;
    let attempts = 0;
    const scroll = (align: "auto" | "start" | "end" | "center") => {
      if (request.current !== current || latestRows.current[index]?.key !== key) return;
      const offset = list.getOffsetForIndex(index, align);
      if (!offset) return;
      // A no-op scroll still synchronously notifies the virtualizer and can
      // flush React from this layout effect. Keep measurement retries, but
      // scroll only when the target actually needs to move.
      if (Math.abs(offset[0] - (list.scrollOffset ?? 0)) > 1) list.scrollToOffset(offset[0]);
      current.frame = requestAnimationFrame(() => {
        current.frame = null;
        if (request.current !== current || latestRows.current[index]?.key !== key) return;
        const measured = list.getOffsetForIndex(index, offset[1]);
        if (measured && Math.abs(measured[0] - (list.scrollOffset ?? 0)) > 1 && ++attempts < 10) {
          scroll(offset[1]);
        } else {
          request.current = null;
        }
      });
    };
    scroll("auto");
  }, [cancel, enabled, list]);

  useLayoutEffect(() => {
    const element = list.scrollElement;
    if (!enabled || !element) return cancel;
    // Wheel/drag input takes ownership from automatic reveal, just as a new
    // Home/End/arrow request does. Own scroll events continue measurement.
    element.addEventListener("wheel", cancel, { passive: true });
    element.addEventListener("pointerdown", cancel, true);
    return () => {
      cancel();
      element.removeEventListener("wheel", cancel);
      element.removeEventListener("pointerdown", cancel, true);
    };
  }, [cancel, enabled, list]);

  return reveal;
}
