import { useCallback } from "react";
import { readFiles as readClipboardFiles, readText as readClipboardText } from "../../../lib/clipboard";
import { applyExtended, ctrlAltDelSequence, encodeKey, encodePointer, encodeWheel, keyEventToScancode, mouseButtonMask, wheelDeltaToRotationUnits } from "../../../lib/rdp";
import { canvasPointFromClient } from "./canvas";
import { useRdpConnection } from "./useRdpConnection";

export interface UseRdpInputContext {
  connection: ReturnType<typeof useRdpConnection>;
  visible: boolean;
  conn: import("../../../stores/rdpStore").RdpConnectionState;
  toggleOsFullscreen: () => void;
  detachedWindowControls: { onReattach: () => void; onToggleOsFullscreen: () => void; osFullscreen: boolean; } | undefined;
  osFullscreen: boolean;
  setBarReveal: import("react").Dispatch<import("react").SetStateAction<number>>;
  canvasRef: import("react").RefObject<HTMLCanvasElement | null>;
}

export function useRdpInput(context: UseRdpInputContext) {
  const { connection, visible, conn, toggleOsFullscreen, detachedWindowControls, osFullscreen, setBarReveal, canvasRef } = context;

  /* ── Input handlers ──────────────────────────────────────────────── */

  const syncClipboardForRemotePaste = useCallback(async () => {
    const files = await readClipboardFiles().catch((err) => {
      console.warn("[rdp.clip] read local file clipboard failed:", err);
      return [];
    });
    if (files.length > 0) {
      connection.sendText({ type: "clipboard_files", paths: files });
      window.setTimeout(() => {
        connection.sendBinary(encodeKey(true, 0x1d)); // Ctrl
        connection.sendBinary(encodeKey(true, 0x2f)); // V
        connection.sendBinary(encodeKey(false, 0x2f));
        connection.sendBinary(encodeKey(false, 0x1d));
      }, 40);
      return;
    }

    const text = await readClipboardText().catch((err) => {
      console.warn("[rdp.clip] read local clipboard failed:", err);
      return "";
    });
    if (!text) return;

    connection.sendText({ type: "clipboard", text });
    window.setTimeout(() => {
      connection.sendBinary(encodeKey(true, 0x1d)); // Ctrl
      connection.sendBinary(encodeKey(true, 0x2f)); // V
      connection.sendBinary(encodeKey(false, 0x2f));
      connection.sendBinary(encodeKey(false, 0x1d));
    }, 40);
  }, [connection.sendBinary, connection.sendText]);

  const onKey = useCallback(
    (down: boolean) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const code = e.nativeEvent.code;

      if (connection.composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
        e.preventDefault();
        return;
      }

      // Local view shortcuts intercepted before reaching the remote desktop:
      //   F11 → toggle host-window OS fullscreen
      //   Ctrl+Alt+Home → show the full-screen connection bar (mstsc)
      if (code === "F11") {
        e.preventDefault();
        if (down && !e.nativeEvent.repeat) toggleOsFullscreen();
        return;
      }
      const fullscreen = detachedWindowControls?.osFullscreen ?? osFullscreen;
      if (fullscreen && code === "Home" && e.ctrlKey && e.altKey) {
        e.preventDefault();
        if (down) setBarReveal((n) => n + 1);
        return;
      }

      if (!down && connection.suppressNextPasteKeyUpRef.current && code === "KeyV") {
        connection.suppressNextPasteKeyUpRef.current = false;
        e.preventDefault();
        return;
      }
      if (down && (e.ctrlKey || e.metaKey) && code === "KeyV") {
        e.preventDefault();
        connection.suppressNextPasteKeyUpRef.current = true;
        void syncClipboardForRemotePaste();
        return;
      }
      const sc = keyEventToScancode(e.nativeEvent);
      if (!sc) return;
      e.preventDefault();
      const wireScancode = applyExtended(sc.scancode, sc.extended);
      if (down) connection.pressedScancodesRef.current.add(wireScancode);
      else connection.pressedScancodesRef.current.delete(wireScancode);
      connection.sendBinary(encodeKey(down, wireScancode));
    },
    [
      conn?.status,
      detachedWindowControls?.osFullscreen,
      osFullscreen,
      connection.sendBinary,
      syncClipboardForRemotePaste,
      toggleOsFullscreen,
      visible,
    ],
  );

  const sendCtrlAltDel = useCallback(() => {
    for (const [down, scancode] of ctrlAltDelSequence()) {
      connection.sendBinary(encodeKey(down, scancode));
    }
  }, [connection.sendBinary]);

  const onCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      connection.composingRef.current = false;
      const text = e.data;
      e.currentTarget.value = "";
      if (!text || !visible || conn?.status !== "connected") return;
      const characters = Array.from(text);
      for (let offset = 0; offset < characters.length; offset += 1024) {
        connection.sendText({ type: "unicode", text: characters.slice(offset, offset + 1024).join("") });
      }
    },
    [conn?.status, connection.sendText, visible],
  );

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);
      connection.sendBinary(encodePointer(x, y, mouseButtonMask(e.nativeEvent)));
    },
    [conn?.status, connection.sendBinary, visible],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);

      const verticalUnits = wheelDeltaToRotationUnits(e.deltaY, e.deltaMode);
      if (verticalUnits !== 0) {
        connection.sendBinary(encodeWheel(x, y, -verticalUnits, true));
      }

      const horizontalUnits = wheelDeltaToRotationUnits(e.deltaX, e.deltaMode);
      if (horizontalUnits !== 0) {
        connection.sendBinary(encodeWheel(x, y, horizontalUnits, false));
      }
    },
    [conn?.status, connection.sendBinary, visible],
  );
  return {
    onKey,
    sendCtrlAltDel,
    onPointer,
    onWheel,
    onCompositionEnd,
  };
}
