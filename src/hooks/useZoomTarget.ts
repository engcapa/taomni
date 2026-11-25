import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ContentZoomAction } from "../lib/contentZoomShortcut";
import { registerZoomTarget } from "../lib/pageZoom";

export function useZoomTarget(root: RefObject<HTMLElement | null>, active: boolean,
  change: (action: ContentZoomAction, focus: Element | null) => void, pageKeyboard = false) {
  const changeRef = useRef(change);
  useLayoutEffect(() => { changeRef.current = change; }, [change]);
  useLayoutEffect(() => {
    if (!active) return;
    return registerZoomTarget({
      element: () => root.current,
      change: (action, focus) => changeRef.current(action, focus),
      pageKeyboard,
    });
  }, [root, active, pageKeyboard]);
}
