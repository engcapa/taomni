import { useEffect, useState } from "react";
import { encodeWsKey } from "../../../../../src/lib/vnc/viewerProtocol";
import type { WsOutgoing } from "../../../../../src/lib/vnc/viewerProtocol";
import { type VncViewerOptions } from "../../../../../src/lib/vncOptions";
import { getAppPlatform, isTauriRuntime, listenVncSpecialKey, setVncSpecialKeyCapture } from "../../../../../src/lib/vnc/viewerHost";
import { SPECIAL_KEY_KEYSYMS } from "./keyboardPolicy";


export interface UseVncSpecialKeysContext {
  visible: boolean;
  conn: import("../vncStore").VncConnectionState;
  viewOnly: boolean;
  viewer: VncViewerOptions;
  canvasFocused: boolean;
  canvasFocusedRef: import("react").RefObject<boolean>;
  flushAltGrRef: import("react").RefObject<() => void>;
  onSpecialKeyRef: import("react").RefObject<((code: string, down: boolean) => void) | null>;
  sendWs: (message: WsOutgoing) => void;
  sendWsBinary: (data: ArrayBuffer) => boolean;
  pressedKeysymsRef: import("react").RefObject<Set<number>>;
}

export function useVncSpecialKeys(context: UseVncSpecialKeysContext) {
  const {
    visible, conn, viewOnly, viewer, canvasFocused, canvasFocusedRef, flushAltGrRef,
    onSpecialKeyRef, sendWs, sendWsBinary, pressedKeysymsRef,
  } = context;

  // ── Special keys (VNC-INPUT-003, Windows) ─────────────────────────
  // While the canvas has focus in the foreground window, a low-level
  // keyboard hook in the backend swallows Win, Alt+Tab, Alt+Esc, Ctrl+Esc
  // and PrtScn locally and hands them to this session (RealVNC
  // SendSpecialKeys=True).
  const [windowFocused, setWindowFocused] = useState(() => typeof document === "undefined" || document.hasFocus());
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const captureSpecialKeys = isTauriRuntime()
    && getAppPlatform() === "windows"
    && visible
    && conn?.status === "connected"
    && !viewOnly
    && viewer.passSpecialKeys
    && canvasFocused
    && windowFocused;
  useEffect(() => {
    if (!captureSpecialKeys) return;
    const forward = (code: string, down: boolean) => {
      const keysym = SPECIAL_KEY_KEYSYMS[code];
      if (!keysym || !canvasFocusedRef.current) return;
      // Ctrl+Esc: the Ctrl held back by the AltGr check must reach the
      // remote before the intercepted key, or the remote sees a plain Esc.
      if (down) flushAltGrRef.current();
      sendWsBinary(encodeWsKey(down, keysym));
      if (down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    };
    if (conn?.nativeSpecialKeys) {
      onSpecialKeyRef.current = forward;
      sendWs({ type: "special_key_capture", enabled: true });
      return () => {
        onSpecialKeyRef.current = null;
        sendWs({ type: "special_key_capture", enabled: false });
      };
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void setVncSpecialKeyCapture(true).catch(() => { });
    void listenVncSpecialKey(({ code, down }) => {
      forward(code, down);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
      void setVncSpecialKeyCapture(false).catch(() => { });
    };
  }, [captureSpecialKeys, conn?.sessionId, conn?.nativeSpecialKeys, sendWs, sendWsBinary]);
  return { captureSpecialKeys };
}
