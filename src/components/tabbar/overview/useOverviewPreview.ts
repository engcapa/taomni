import { useCallback, useEffect, useRef, useState } from "react";

const PREVIEW_DELAY = 2_000;

export function useOverviewPreview() {
  const timer = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<{ id: string; bounds: DOMRect } | null>(null);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPreview(null);
  }, []);
  const hover = (id: string, card: HTMLButtonElement) => {
    clear();
    timer.current = window.setTimeout(() => {
      if (card.isConnected) setPreview({ id, bounds: card.getBoundingClientRect() });
    }, PREVIEW_DELAY);
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
