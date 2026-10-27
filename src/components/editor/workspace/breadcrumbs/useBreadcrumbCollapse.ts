import { useLayoutEffect, useRef, useState } from "react";
import type { BreadcrumbItem } from "./model";

/** One observer per mounted trail; all measurements run outside RO delivery. */
export function useBreadcrumbCollapse(items: readonly BreadcrumbItem[]) {
  const navRef = useRef<HTMLElement | null>(null);
  const fullPathMeasureRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const scheduleRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    let frame: number | null = null;
    let disposed = false;
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (disposed) return;
        const availableWidth = navRef.current?.clientWidth ?? 0;
        const fullPathWidth = fullPathMeasureRef.current?.getBoundingClientRect().width ?? 0;
        if (availableWidth > 0 && fullPathWidth > 0) {
          setCollapsed(fullPathWidth > availableWidth);
        }
      });
    };
    scheduleRef.current = schedule;
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (navRef.current) observer?.observe(navRef.current);
    return () => {
      disposed = true;
      scheduleRef.current = null;
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    // Edit/save publishes a new trail without changing its mounted owner.
    // Recreating its observer or measuring synchronously here can invalidate
    // a delivered ancestor when another observer triggered the React update.
    scheduleRef.current?.();
  }, [items]);

  return { navRef, fullPathMeasureRef, collapsed };
}
