import { useEffect, useRef, useCallback } from "react";
import { encodeWsPointer, mapClientToFramebuffer, mouseButtonMask, VncWheelAccumulator } from "../../../lib/vnc";
import type { VncNativePointerTarget, WsOutgoing } from "../../../lib/vnc";
import { VncPointerScheduler, type VncPointerState } from "../../../lib/vncPointerScheduler";
import { type DelayedPointerDown } from "./types";
import { MIDDLE_CLICK_CLIPBOARD_WAIT_MS } from "./clipboardPolicy";


export interface UseVncPointerContext {
  canvasRef: import("react").RefObject<HTMLCanvasElement | null>;
  conn: import("../../../stores/vncStore").VncConnectionState;
  lastPointerSentRef: import("react").RefObject<VncPointerState | null>;
  sendWsBinary: (data: ArrayBuffer) => boolean;
  pointerSchedulerRef: import("react").RefObject<VncPointerScheduler | null>;
  nativePointerAvailableRef: import("react").RefObject<boolean>;
  viewOnly: boolean;
  wsRef: import("react").RefObject<WebSocket | null>;
  sendWs: (msg: WsOutgoing) => void;
  nativePointerOnRef: import("react").RefObject<boolean>;
  delayedPointerDownRef: import("react").RefObject<DelayedPointerDown | null>;
  rawPointerMovesRef: import("react").RefObject<boolean>;
  syncLocalClipboardToServer: (reason: string, force?: boolean) => Promise<void>;
  clipboardSyncPromiseRef: import("react").RefObject<Promise<void> | null>;
  destroyedRef: import("react").RefObject<boolean>;
  wheelAccumulatorRef: import("react").RefObject<VncWheelAccumulator>;
}

export function useVncPointer(context: UseVncPointerContext) {
  const {
    canvasRef,
    conn,
    lastPointerSentRef,
    sendWsBinary,
    pointerSchedulerRef,
    nativePointerAvailableRef,
    viewOnly,
    wsRef,
    sendWs,
    nativePointerOnRef,
    delayedPointerDownRef,
    rawPointerMovesRef,
    syncLocalClipboardToServer,
    clipboardSyncPromiseRef,
    destroyedRef,
    wheelAccumulatorRef,
  } = context;

  // ── Pointer ───────────────────────────────────────────────────────
  const getFbCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const fbWidth = conn?.width ?? 0;
      const fbHeight = conn?.height ?? 0;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      // The canvas element is always sized to the scaled desktop (no
      // letterboxing inside it), so its box maps 1:1 onto the framebuffer.
      return mapClientToFramebuffer(clientX, clientY, rect, fbWidth, fbHeight, "one");
    },
    [conn?.width, conn?.height],
  );

  const sendPointerNow = useCallback(
    (pointer: VncPointerState) => {
      const last = lastPointerSentRef.current;
      if (
        last &&
        last.x === pointer.x &&
        last.y === pointer.y &&
        last.buttons === pointer.buttons
      ) {
        return;
      }
      if (sendWsBinary(encodeWsPointer(pointer.x, pointer.y, pointer.buttons))) {
        lastPointerSentRef.current = pointer;
      }
    },
    [sendWsBinary],
  );

  const pointerScheduler = useCallback(() => {
    if (!pointerSchedulerRef.current) {
      pointerSchedulerRef.current = new VncPointerScheduler({ send: sendPointerNow });
    }
    return pointerSchedulerRef.current;
  }, [sendPointerNow]);

  // VNC-PERF-005 / DEC-VNC-20: Windows delivers cursor moves to the WebView
  // one or two vsync periods late. While the pointer rests over the canvas
  // the relay reads the cursor itself; this panel reports where the canvas
  // is and keeps sending its own events (the relay drops the late copies).
  const nativePointerTarget = useCallback((): VncNativePointerTarget | null => {
    const canvas = canvasRef.current;
    const fbWidth = conn?.width ?? 0;
    const fbHeight = conn?.height ?? 0;
    if (!canvas || fbWidth <= 0 || fbHeight <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
      fb_width: fbWidth,
      fb_height: fbHeight,
    };
  }, [conn?.width, conn?.height]);

  const startNativePointer = useCallback(() => {
    if (!nativePointerAvailableRef.current || viewOnly || conn?.status !== "connected") return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const target = nativePointerTarget();
    if (!target) return;
    sendWs({ type: "native_pointer", on: true, ...target });
    nativePointerOnRef.current = true;
  }, [conn?.status, nativePointerTarget, sendWs, viewOnly]);

  const stopNativePointer = useCallback(() => {
    if (!nativePointerOnRef.current) return;
    nativePointerOnRef.current = false;
    sendWs({ type: "native_pointer", on: false });
  }, [sendWs]);
  const stopNativePointerRef = useRef(stopNativePointer);
  stopNativePointerRef.current = stopNativePointer;

  // The canvas moved or resized, or the framebuffer changed size: report the
  // new geometry while sampling is on.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || conn?.status !== "connected") return;
    const refresh = () => {
      if (nativePointerOnRef.current) startNativePointer();
    };
    refresh();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(canvas);
    window.addEventListener("resize", refresh);
    document.addEventListener("scroll", refresh, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", refresh);
      document.removeEventListener("scroll", refresh, true);
    };
  }, [conn?.status, startNativePointer]);

  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (viewOnly || conn?.status !== "connected") return;
      if (delayedPointerDownRef.current?.pointerId === e.pointerId) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped) return;
      const allowOutside = ((e.type === "pointerup" || e.type === "pointercancel")
        && (lastPointerSentRef.current?.buttons ?? 0) !== 0)
        || (e.type === "pointermove" && e.buttons !== 0);
      if (!mapped.inside && !allowOutside) return;
      const { x, y } = mapped;
      const buttons = mouseButtonMask(e.nativeEvent);
      const pointer = { x, y, buttons };

      if (e.type === "pointermove") {
        if (buttons === 0 && mapped.inside && !nativePointerOnRef.current) startNativePointer();
        // Chromium (WebView2) delivers moves earlier as pointerrawupdate;
        // once those arrive, the frame-aligned pointermove is a duplicate.
        if (rawPointerMovesRef.current) return;
        pointerScheduler().move(pointer);
        return;
      }

      pointerScheduler().sendNow(pointer);
    },
    [viewOnly, conn?.status, getFbCoords, pointerScheduler, startNativePointer],
  );

  // VNC-PERF-005: pointermove is aligned to the next animation frame, which
  // costs Chromium-based WebViews one to two frames of pointer latency.
  // pointerrawupdate is dispatched as soon as input arrives; WebKit has no
  // such event and keeps the pointermove path.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewOnly || conn?.status !== "connected" || !("onpointerrawupdate" in window)) {
      rawPointerMovesRef.current = false;
      return;
    }
    const onRawUpdate = (event: Event) => {
      const e = event as PointerEvent;
      if (delayedPointerDownRef.current?.pointerId === e.pointerId) return;
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped) return;
      if (!mapped.inside && e.buttons === 0) return;
      rawPointerMovesRef.current = true;
      pointerScheduler().move({ x: mapped.x, y: mapped.y, buttons: mouseButtonMask(e) });
    };
    canvas.addEventListener("pointerrawupdate", onRawUpdate);
    return () => {
      canvas.removeEventListener("pointerrawupdate", onRawUpdate);
      rawPointerMovesRef.current = false;
    };
  }, [viewOnly, conn?.status, getFbCoords, pointerScheduler]);

  // Push a fresh local clipboard when the pointer enters the desktop, so a
  // paste click right after copying elsewhere sees the new content.
  const handlePointerEnter = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewOnly || conn?.status !== "connected") return;
    void syncLocalClipboardToServer("enter", true);
    if (e.buttons === 0) startNativePointer();
  }, [viewOnly, conn?.status, syncLocalClipboardToServer, startNativePointer]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped?.inside) return;
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail if the event was already cancelled.
      }
      // Right clicks go out immediately like RealVNC Viewer. The clipboard is
      // synced on pointer enter / focus instead of delaying the click; only a
      // middle click (X11 paste) waits briefly for a sync that is in flight.
      const pendingClipboardSync = clipboardSyncPromiseRef.current;
      if (!viewOnly && conn?.status === "connected" && e.button === 1 && pendingClipboardSync) {
        e.preventDefault();
        const { x, y } = mapped;
        const delayed: DelayedPointerDown = {
          pointerId: e.pointerId,
          down: { x, y, buttons: mouseButtonMask(e.nativeEvent) },
          up: null,
        };
        delayedPointerDownRef.current = delayed;
        pointerSchedulerRef.current?.cancelPending();
        void (async () => {
          await Promise.race([
            pendingClipboardSync,
            new Promise((resolve) => window.setTimeout(resolve, MIDDLE_CLICK_CLIPBOARD_WAIT_MS)),
          ]);
          if (destroyedRef.current || delayedPointerDownRef.current !== delayed) return;
          sendPointerNow(delayed.down);
          if (delayed.up) {
            sendPointerNow(delayed.up);
          }
          delayedPointerDownRef.current = null;
        })();
        return;
      }
      handlePointer(e);
    },
    [viewOnly, conn?.status, getFbCoords, handlePointer, sendPointerNow, syncLocalClipboardToServer],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const delayed = delayedPointerDownRef.current;
      if (delayed?.pointerId === e.pointerId) {
        e.preventDefault();
        const mapped = getFbCoords(e.clientX, e.clientY);
        if (mapped) {
          delayed.up = { x: mapped.x, y: mapped.y, buttons: mouseButtonMask(e.nativeEvent) };
        }
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // The pointer may already have been released by the platform.
        }
        return;
      }
      handlePointer(e);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // The pointer may already have been released by the platform.
      }
    },
    [getFbCoords, handlePointer],
  );

  // Wheel: a native non-passive listener so preventDefault stops the page (or
  // the scrolling container) from scrolling. Deltas accumulate into detents;
  // each detent is an immediate press+release that keeps held buttons.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewOnly || conn?.status !== "connected") return;
    const accumulator = wheelAccumulatorRef.current;
    accumulator.reset();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped?.inside) return;
      const steps = accumulator.push(
        e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX,
        e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY,
        e.deltaMode,
      );
      if (steps.length === 0) return;
      pointerSchedulerRef.current?.cancelPending();
      const held = mouseButtonMask(e);
      for (const step of steps) {
        sendWsBinary(encodeWsPointer(mapped.x, mapped.y, held | step));
        sendWsBinary(encodeWsPointer(mapped.x, mapped.y, held));
      }
      lastPointerSentRef.current = { x: mapped.x, y: mapped.y, buttons: held };
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [viewOnly, conn?.status, getFbCoords, sendWsBinary]);
  return { stopNativePointerRef, handlePointerDown, handlePointer, handlePointerUp, handlePointerEnter, stopNativePointer };
}
