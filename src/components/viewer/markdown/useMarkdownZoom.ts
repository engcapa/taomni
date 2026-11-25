import { useCallback, useEffect, useState, type RefObject } from "react";
import { contentZoomShortcut, type ContentZoomAction } from "../../../lib/contentZoomShortcut";

export function useMarkdownZoom(content: RefObject<HTMLDivElement | null>, active: boolean) {
  const [percent, setPercent] = useState(100);
  const change = useCallback((action: ContentZoomAction) => {
    setPercent((value) => action === "reset" ? 100 : Math.min(200, Math.max(60, value + (action === "in" ? 10 : -10))));
  }, []);
  const onKeyDown = useCallback((event: KeyboardEvent | React.KeyboardEvent) => {
    const native = "nativeEvent" in event ? event.nativeEvent : event;
    if (!active || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input,textarea,select")) return;
    const action = contentZoomShortcut(native);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    change(action);
  }, [active, change]);
  useEffect(() => {
    const element = content.current;
    if (!active || !element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY !== 0) change(event.deltaY < 0 ? "in" : "out");
    };
    element.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => element.removeEventListener("wheel", wheel, true);
  }, [active, content, change]);
  return { percent, onKeyDown };
}
