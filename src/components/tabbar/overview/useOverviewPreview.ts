import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pointer rest time before the large Overview preview enlarges a card.
 *
 * The preview covers a large part of the window, so it must not pop while the
 * pointer merely crosses the grid. 700 ms sits in the conventional 0.5-1 s
 * hover-reveal range: quick enough to feel immediate after an intentional stop
 * (tooltips use ~300-500 ms, heavier content previews ~0.6-1 s), yet slow
 * enough to avoid accidental enlargements while scanning neighbouring cards.
 */
export const OVERVIEW_PREVIEW_DELAY_MS = 700;

export interface OverviewPreviewState {
  id: string;
  bounds: DOMRect;
}

export function useOverviewPreview() {
  const timer = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<OverviewPreviewState | null>(null);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPreview(null);
  }, []);
  const hover = (id: string, card: HTMLButtonElement) => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (card.isConnected) setPreview({ id, bounds: card.getBoundingClientRect() });
    }, OVERVIEW_PREVIEW_DELAY_MS);
  };
  useEffect(() => {
    window.addEventListener("resize", clear);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("resize", clear);
    };
  }, [clear]);
  return { preview, hover, clear };
}
