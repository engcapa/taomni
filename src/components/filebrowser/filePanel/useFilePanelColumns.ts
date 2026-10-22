import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { DEFAULT_COL_WIDTHS, clampCol, loadColWidths, saveColWidths } from "./preferences";
import { type ColWidths } from "./types";

export interface UseFilePanelColumnsContext {
  side: import("../../../stores/sftpStore").PaneSide;
}

export function useFilePanelColumns(context: UseFilePanelColumnsContext) {
  const { side } = context;

  const [colWidths, setColWidths] = useState<ColWidths>(() => loadColWidths(side));
  const colWidthsRef = useRef(colWidths);
  const dragColRef = useRef<{ key: keyof ColWidths; startX: number; startW: number; } | null>(null);

  // Keep storage in step with the drag; React effects may flush after the
  // next interaction has already read the width.
  const persistColWidths = useCallback((next: ColWidths) => {
    colWidthsRef.current = next;
    setColWidths(next);
    saveColWidths(side, next);
  }, [side]);

  const resetCol = useCallback((key: keyof ColWidths) => {
    persistColWidths({
      ...colWidthsRef.current,
      [key]: DEFAULT_COL_WIDTHS[key],
    });
  }, [persistColWidths]);

  const startColResize = useCallback(
    (key: keyof ColWidths, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragColRef.current = { key, startX: e.clientX, startW: colWidthsRef.current[key] };
      const onMove = (ev: globalThis.MouseEvent) => {
        const ctx = dragColRef.current;
        if (!ctx) return;
        const next = clampCol(ctx.startW + (ev.clientX - ctx.startX));
        const current = colWidthsRef.current;
        if (current[ctx.key] === next) return;
        persistColWidths({ ...current, [ctx.key]: next });
      };
      const onUp = () => {
        dragColRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [persistColWidths],
  );

  useEffect(() => {
    saveColWidths(side, colWidthsRef.current);
  }, [side]);
  return { colWidths, startColResize, resetCol };
}
