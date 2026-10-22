import { useEffect, useState } from "react";
import { encodeWsKey } from "../../../lib/vnc";
import { type VncViewerOptions } from "../../../lib/vncOptions";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { SPECIAL_KEY_KEYSYMS } from "./keyboardPolicy";


export interface UseVncSpecialKeysContext {
  visible: boolean;
  conn: import("../../../stores/vncStore").VncConnectionState;
  viewOnly: boolean;
  viewer: VncViewerOptions;
  canvasFocused: boolean;
  canvasFocusedRef: import("react").RefObject<boolean>;
  flushAltGrRef: import("react").RefObject<() => void>;
  sendWsBinary: (data: ArrayBuffer) => boolean;
  pressedKeysymsRef: import("react").RefObject<Set<number>>;
}

export function useVncSpecialKeys(context: UseVncSpecialKeysContext) {
  const { visible, conn, viewOnly, viewer, canvasFocused, canvasFocusedRef, flushAltGrRef, sendWsBinary, pressedKeysymsRef } = context;

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
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void invoke("vnc_set_special_key_capture", { enabled: true }).catch(() => { });
    void listen<{ code: string; down: boolean; }>("vnc-special-key", (event) => {
      const keysym = SPECIAL_KEY_KEYSYMS[event.payload.code];
      if (!keysym || !canvasFocusedRef.current) return;
      // Ctrl+Esc: the Ctrl held back by the AltGr check must reach the
      // remote before the intercepted key, or the remote sees a plain Esc.
      if (event.payload.down) flushAltGrRef.current();
      sendWsBinary(encodeWsKey(event.payload.down, keysym));
      if (event.payload.down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
      void invoke("vnc_set_special_key_capture", { enabled: false }).catch(() => { });
    };
  }, [captureSpecialKeys, sendWsBinary]);
  return { captureSpecialKeys };
}
