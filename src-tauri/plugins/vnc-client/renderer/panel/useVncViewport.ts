import { useState, useEffect } from "react";
import { computeVncDisplaySize } from "../../../../../src/lib/vnc/viewerProtocol";
import type { VncScaling } from "../../../../../src/lib/vnc/viewerProtocol";


export interface UseVncViewportContext {
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  scaling: VncScaling;
  conn: import("../vncStore").VncConnectionState;
  preserveAspect: boolean;
  remoteCursorCss: string;
}

export function useVncViewport(context: UseVncViewportContext) {
  const { containerRef, scaling, conn, preserveAspect, remoteCursorCss } = context;

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);


  // ── Viewport tracking for scaling ─────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      setViewportSize({ width: container.clientWidth, height: container.clientHeight });
      setDevicePixelRatio(window.devicePixelRatio || 1);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(container);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const displaySize = computeVncDisplaySize(
    scaling,
    conn?.width ?? 0,
    conn?.height ?? 0,
    viewportSize.width,
    viewportSize.height,
    devicePixelRatio,
    preserveAspect,
  );

  // ── Canvas CSS size for scaling ───────────────────────────────────
  const canvasStyle: React.CSSProperties = {
    width: displaySize.width,
    height: displaySize.height,
    flex: "none",
    // Center when smaller than the viewport; scroll from the top-left edge
    // when larger (auto margins collapse to 0 in an overflowing flex box).
    margin: "auto",
    cursor: conn?.status === "connected" ? remoteCursorCss : "default",
    maxWidth: "none",
    maxHeight: "none",
  };
  return { displaySize, canvasStyle, viewportSize, setViewportSize, devicePixelRatio, setDevicePixelRatio };
}
