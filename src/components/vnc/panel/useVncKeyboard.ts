import { useRef, useEffect } from "react";
import { encodeWsKey, encodeWsPointer, keyEventToKeysym } from "../../../lib/vnc";
import type { WsOutgoing } from "../../../lib/vnc";
import { type VncViewerOptions } from "../../../lib/vncOptions";
import { getAppPlatform } from "../../../lib/runtime";
import { type VncPointerState } from "../../../lib/vncPointerScheduler";
import { isEditableTarget, isTerminalFocused } from "../../../lib/terminal/keyboardGuards";
import { readMultiFormat } from "../../../lib/clipboard";
import { readVncClipboardText, pasteModifierKeysyms, hasNonAsciiText, PASTE_KEY_DELAY_MS, modifierKeysymFromKey, isPasteShortcut } from "./clipboardPolicy";
import { ALTGR_FLUSH_MS, ALTGR_PAIR_WINDOW_MS } from "./keyboardPolicy";


export interface UseVncKeyboardContext {
  visible: boolean;
  conn: import("../../../stores/vncStore").VncConnectionState;
  sendWs: (msg: WsOutgoing) => void;
  pasteInFlightRef: import("react").RefObject<{ pasteKeysym: number; heldModifiers: Set<number>; deferredKeyUps: Set<number>; } | null>;
  lastSyncedLocalClipboardTextRef: import("react").RefObject<string | null>;
  extClipboardSupportedRef: import("react").RefObject<boolean>;
  destroyedRef: import("react").RefObject<boolean>;
  pasteDelayTimerRef: import("react").RefObject<number | null>;
  sendWsBinary: (data: ArrayBuffer) => boolean;
  stopNativePointerRef: import("react").RefObject<() => void>;
  pressedKeysymsRef: import("react").RefObject<Set<number>>;
  latchedKeysymsRef: import("react").RefObject<Set<number>>;
  keyCodeKeysymsRef: import("react").RefObject<Map<string, number>>;
  lastPointerSentRef: import("react").RefObject<VncPointerState | null>;
  viewerRef: import("react").RefObject<VncViewerOptions>;
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  viewOnly: boolean;
  openSessionMenuRef: import("react").RefObject<(x?: number, y?: number) => void>;
  allowClipboardSend: boolean;
}

export function useVncKeyboard(context: UseVncKeyboardContext) {
  const {
    visible,
    conn,
    sendWs,
    pasteInFlightRef,
    lastSyncedLocalClipboardTextRef,
    extClipboardSupportedRef,
    destroyedRef,
    pasteDelayTimerRef,
    sendWsBinary,
    pressedKeysymsRef,
    latchedKeysymsRef,
    keyCodeKeysymsRef,
    lastPointerSentRef,
    viewerRef,
    containerRef,
    viewOnly,
    openSessionMenuRef,
    allowClipboardSend,
  } = context;

  const altGrArmedRef = useRef<{ timeStamp: number; timer: number; } | null>(null);
  const altGrSuppressedCtrlRef = useRef(false);
  // Sends a Ctrl press still held back by the AltGr check (set by the key handler).
  const flushAltGrRef = useRef<() => void>(() => { });


  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const readLocalClipboard = async (): Promise<{
      text: string;
      html?: string;
      rtf?: string;
    } | null> => {
      try {
        const data = await readMultiFormat();
        data.text = await readVncClipboardText(data.text);
        if (!data.text && !data.html && !data.rtf) return null;
        return { text: data.text || "", html: data.html, rtf: data.rtf };
      } catch (err) {
        console.warn("[vnc.clip] read local clipboard failed:", err);
        return null;
      }
    };

    const sendExtClipboardToRelay = (data: {
      text: string;
      html?: string;
      rtf?: string;
    }) => {
      sendWs({
        type: "ext_clipboard",
        text: data.text || undefined,
        html: data.html,
        rtf: data.rtf,
      });
    };

    /**
     * When the user presses Ctrl+V on the canvas, send the clipboard content
     * via the relay (UTF-8 legacy ClientCutText for servers without
     * ExtendedClipboard, ExtendedClipboard for servers that support it).
     * instead and deliberately do not send the remote V shortcut.
     */
    const handlePasteShortcut = (e: KeyboardEvent) => {
      const pasteKeysym = keyEventToKeysym(e);
      if (pasteKeysym === 0 || pasteInFlightRef.current) return;

      pasteInFlightRef.current = {
        pasteKeysym,
        heldModifiers: pasteModifierKeysyms(e),
        deferredKeyUps: new Set<number>(),
      };

      void (async () => {
        const clipboard = await readLocalClipboard();
        const text = clipboard?.text ?? "";
        if (clipboard) {
          lastSyncedLocalClipboardTextRef.current = text;
          sendExtClipboardToRelay(clipboard);
        }
        console.info(
          `[vnc.clip] paste shortcut: text_len=${text.length} non_ascii=${hasNonAsciiText(text)} ext_support=${extClipboardSupportedRef.current} → clipboard+V`,
        );

        if (destroyedRef.current) {
          pasteInFlightRef.current = null;
          return;
        }
        if (pasteDelayTimerRef.current !== null) {
          window.clearTimeout(pasteDelayTimerRef.current);
        }

        // Wait briefly so the relay has time to ship the clipboard payload
        // ahead of the V keystroke (when we send one).
        pasteDelayTimerRef.current = window.setTimeout(() => {
          pasteDelayTimerRef.current = null;
          const pending = pasteInFlightRef.current;
          if (!pending || destroyedRef.current) {
            pasteInFlightRef.current = null;
            return;
          }

          // Release any held modifiers (Ctrl/Cmd/Shift) before injecting
          // characters — otherwise the remote app sees Ctrl+character
          // shortcuts instead of plain text.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });

          // Re-press modifiers and send V so the remote app's paste shortcut
          // fires against the now-updated clipboard.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(true, modKeysym));
          });
          sendWsBinary(encodeWsKey(true, pasteKeysym));
          sendWsBinary(encodeWsKey(false, pasteKeysym));

          // The user's physical modifier keys are still held — defer their
          // key-ups until the user actually releases them so we don't
          // generate phantom up events.
          pending.deferredKeyUps.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });
          pasteInFlightRef.current = null;
        }, PASTE_KEY_DELAY_MS);
      })();
    };

    // Dead-key composition state (see handleKey / handleKeyPress).
    let deadKeyPending = false;
    let composingCode: string | null = null;

    const releaseAllInput = () => {
      deadKeyPending = false;
      composingCode = null;
      context.stopNativePointerRef.current();
      pressedKeysymsRef.current.forEach((keysym) => {
        // Keys latched from the session menu stay down until toggled off.
        if (!latchedKeysymsRef.current.has(keysym)) sendWsBinary(encodeWsKey(false, keysym));
      });
      pressedKeysymsRef.current.clear();
      keyCodeKeysymsRef.current.clear();
      const last = lastPointerSentRef.current;
      if (last && last.buttons !== 0) {
        sendWsBinary(encodeWsPointer(last.x, last.y, 0));
        lastPointerSentRef.current = { ...last, buttons: 0 };
      }
    };

    const isWindows = getAppPlatform() === "windows";
    const isMenuKey = (e: KeyboardEvent) => {
      const menuKey = viewerRef.current.menuKey;
      return menuKey !== "none" && e.key === menuKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    };
    const sendKey = (down: boolean, keysym: number) => {
      sendWsBinary(encodeWsKey(down, keysym));
      if (down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    };
    // VNC-INPUT-003 / DEC-VNC-17: Windows reports AltGr as a synthetic
    // ControlLeft immediately followed by AltRight. Hold a ControlLeft press
    // briefly; when AltGr follows at the same timestamp the Ctrl is dropped so
    // the remote sees ISO_Level3_Shift + the character, not Ctrl+Alt+char.
    const flushAltGr = () => {
      const armed = altGrArmedRef.current;
      if (!armed) return;
      window.clearTimeout(armed.timer);
      altGrArmedRef.current = null;
      keyCodeKeysymsRef.current.set("ControlLeft", 0xffe3);
      sendKey(true, 0xffe3);
    };
    flushAltGrRef.current = flushAltGr;

    const handleKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl))
        return;
      if (!isTerminalFocused(containerRef.current, activeEl))
        return;
      if (viewOnly) {
        if (isMenuKey(e) && e.type === "keydown" && !e.repeat) {
          e.preventDefault();
          openSessionMenuRef.current();
        }
        return;
      }

      if (isWindows) {
        const armed = altGrArmedRef.current;
        if (e.type === "keydown" && e.code === "ControlLeft" && !e.repeat) {
          e.preventDefault();
          flushAltGr();
          const timer = window.setTimeout(flushAltGr, ALTGR_FLUSH_MS);
          altGrArmedRef.current = { timeStamp: e.timeStamp, timer };
          return;
        }
        if (armed && e.type === "keydown" && (e.key === "AltGraph" || e.code === "AltRight")
          && e.timeStamp - armed.timeStamp <= ALTGR_PAIR_WINDOW_MS) {
          window.clearTimeout(armed.timer);
          altGrArmedRef.current = null;
          altGrSuppressedCtrlRef.current = true;
        } else if (armed) {
          flushAltGr();
        }
        if (e.type === "keyup" && e.code === "ControlLeft" && altGrSuppressedCtrlRef.current) {
          e.preventDefault();
          altGrSuppressedCtrlRef.current = false;
          return;
        }
      }

      const pendingPaste = pasteInFlightRef.current;
      if (pendingPaste && e.type === "keyup") {
        const modifierKeysym = modifierKeysymFromKey(e.key);
        if (modifierKeysym && pendingPaste.heldModifiers.has(modifierKeysym)) {
          e.preventDefault();
          pendingPaste.deferredKeyUps.add(modifierKeysym);
          return;
        }
        const keysym = keyEventToKeysym(e);
        if (keysym === pendingPaste.pasteKeysym) {
          e.preventDefault();
          return;
        }
      }

      // The menu key (F8 by default) opens the session menu, as in RealVNC
      // Viewer ("Send F8" in the menu delivers the key itself).
      if (isMenuKey(e)) {
        e.preventDefault();
        if (e.type === "keydown" && !e.repeat) {
          openSessionMenuRef.current();
        }
        return;
      }

      // Intercept Ctrl/Meta + V so the remote clipboard is updated before the
      // remote application receives the paste shortcut.
      if (isPasteShortcut(e)) {
        e.preventDefault();
        if (e.type === "keydown" && !e.repeat) {
          handlePasteShortcut(e);
        }
        return;
      }

      // VNC-INPUT-003 / DEC-VNC-17: the OS composes a dead key with the next
      // key and reports the result only as keypress (the keydowns say "Dead"
      // and then the bare letter). Neither keydown is sent and neither is
      // default-prevented; the composed character goes out on keypress, the
      // way RealVNC Viewer sends it.
      if (e.type === "keydown" && e.key === "Dead") {
        // A second dead key makes the OS type the accent itself.
        if (deadKeyPending) composingCode = e.code;
        deadKeyPending = !deadKeyPending;
        return;
      }
      if (e.type === "keydown" && deadKeyPending && !modifierKeysymFromKey(e.key)) {
        deadKeyPending = false;
        const plain = (!e.ctrlKey && !e.altKey && !e.metaKey) || e.getModifierState?.("AltGraph");
        if (plain && [...e.key].length === 1) {
          composingCode = e.code;
          return;
        }
      }
      if (e.type === "keyup" && composingCode !== null && e.code === composingCode) {
        composingCode = null;
        e.preventDefault();
        return;
      }

      if (e.type === "keyup" && e.code) {
        // Release exactly what this physical key pressed; a key-up whose
        // key-down went elsewhere (e.g. Esc closing the session menu) is not
        // forwarded, matching RealVNC Viewer.
        const pressed = keyCodeKeysymsRef.current.get(e.code);
        if (pressed === undefined) {
          if (keyEventToKeysym(e) !== 0) e.preventDefault();
          return;
        }
        keyCodeKeysymsRef.current.delete(e.code);
        e.preventDefault();
        sendKey(false, pressed);
        return;
      }
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      if (e.type === "keyup") {
        sendKey(false, keysym);
        return;
      }
      if (e.code) keyCodeKeysymsRef.current.set(e.code, keysym);
      sendKey(true, keysym);
    };

    // The character a dead-key sequence produced (see handleKey).
    const handleKeyPress = (e: KeyboardEvent) => {
      if (composingCode === null || viewOnly) return;
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl) || !isTerminalFocused(containerRef.current, activeEl)) return;
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      sendWsBinary(encodeWsKey(true, keysym));
      sendWsBinary(encodeWsKey(false, keysym));
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    window.addEventListener("keypress", handleKeyPress);

    // Keep the paste listener as a secondary path — useful when the OS
    // dispatches a paste event directly to the WebView.
    const handlePaste = (e: ClipboardEvent) => {
      if (!allowClipboardSend) return;
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl)) return;
      if (!isTerminalFocused(containerRef.current, activeEl)) return;

      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") || undefined;
      const rtf = e.clipboardData?.getData("text/rtf") || undefined;
      if (!text && !html && !rtf) return;
      if (text) {
        lastSyncedLocalClipboardTextRef.current = text;
      }
      sendWs({ type: "ext_clipboard", text, html, rtf });
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("blur", releaseAllInput);
    document.addEventListener("visibilitychange", releaseAllInput);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("keypress", handleKeyPress);
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("blur", releaseAllInput);
      document.removeEventListener("visibilitychange", releaseAllInput);
      if (altGrArmedRef.current) {
        window.clearTimeout(altGrArmedRef.current.timer);
        altGrArmedRef.current = null;
      }
      flushAltGrRef.current = () => { };
    };
  }, [visible, conn?.status, viewOnly, allowClipboardSend, sendWs, sendWsBinary]);
  return { altGrArmedRef, altGrSuppressedCtrlRef, flushAltGrRef };
}
