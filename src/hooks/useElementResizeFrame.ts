import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

interface ResizeOwner {
  element: Element;
  schedule(): void;
  dispose(): void;
}

/** Measure resize-driven chrome outside RO delivery, once per animation frame. */
export function useElementResizeFrame(elementRef: RefObject<Element | null>, measure: () => void) {
  const measureRef = useRef(measure);
  const ownerRef = useRef<ResizeOwner | null>(null);
  const schedule = useCallback(() => ownerRef.current?.schedule(), []);

  useLayoutEffect(() => {
    measureRef.current = measure;
    const element = elementRef.current;
    // Conditional tool/tab strips can replace the element without replacing
    // its ref object. Keep the actual DOM owner, rather than tab-count deps.
    if (ownerRef.current?.element === element) return;
    ownerRef.current?.dispose();
    ownerRef.current = null;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    let disposed = false;
    let frame: number | null = null;
    const queue = () => {
      if (disposed || frame !== null) return;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        if (!disposed) measureRef.current();
      });
    };
    const observer = typeof view.ResizeObserver === "undefined" ? null : new view.ResizeObserver(queue);
    observer?.observe(element);
    view.addEventListener("resize", queue);
    ownerRef.current = {
      element,
      schedule: queue,
      dispose: () => {
        disposed = true;
        observer?.disconnect();
        view.removeEventListener("resize", queue);
        if (frame !== null) view.cancelAnimationFrame(frame);
      },
    };
    queue();
  });

  useLayoutEffect(() => () => {
    ownerRef.current?.dispose();
    ownerRef.current = null;
  }, []);

  return schedule;
}
