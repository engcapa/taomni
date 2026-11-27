import { useState } from "react";
import { nextFontOffset, zoomedFontSize, type ContentZoomAction } from "../../lib/contentZoomShortcut";

export function useNotepadZoom(base: number, activePane: 0 | 1) {
  const [offsets, setOffsets] = useState<[number, number]>([0, 0]);
  const sizes: [number, number] = [zoomedFontSize(base, offsets[0]), zoomedFontSize(base, offsets[1])];
  const change = (action: ContentZoomAction) => {
    setOffsets((current) => {
      const next: [number, number] = [...current];
      next[activePane] = nextFontOffset(action, base, current[activePane]);
      return next;
    });
  };
  return { sizes, percent: Math.round(100 * sizes[activePane] / base), change };
}
