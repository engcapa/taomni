import { useLayoutEffect, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

/** Keep the real panel geometry in sync with the tool's visibility. */
export function useToolWindowPanelVisibility(
  panelRef: RefObject<PanelImperativeHandle | null>,
  open: boolean,
  lastSizeRef: RefObject<number>,
  unit: "px" | "%",
) {
  // User visibility changes must commit their size before the newly visible
  // content paints. The panel library separately defers observer-driven work;
  // adding another frame here exposes a collapsed 0px panel for that frame.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) panel.resize(`${lastSizeRef.current}${unit}`);
    else panel.collapse();
  }, [open, panelRef, lastSizeRef, unit]);
}
